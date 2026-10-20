import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildR2, INDEX_CACHE_CONTROL, PACKAGE_CACHE_CONTROL, repoRoot } from './build-r2.mjs'

export async function deployR2({ root = repoRoot, client, fetchImpl = fetch } = {}) {
  const config = JSON.parse(await readFile(join(root, 'r2.json'), 'utf8'))
  if (!config.accountId || !config.bucket) throw new Error('r2.json requires accountId and bucket')
  if (!client) {
    if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
      throw new Error('Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY using a bucket-scoped Object Read & Write token')
    }
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      },
      // Package integrity is checked against the source index before upload.
      // Avoid optional AWS-specific checksum behavior on the S3-compatible endpoint.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    })
  }
  const { output, objects } = await buildR2({ root, fetchImpl })
  let uploaded = 0
  for (const object of objects) {
    const params = { Bucket: config.bucket, Key: object.key }
    const existing = await client.send(new HeadObjectCommand(params)).catch(error => {
      if (error.$metadata?.httpStatusCode === 404) return null
      throw error
    })
    if (existing) {
      if (existing.Metadata?.sha256 !== object.sha256 || existing.ContentLength !== object.size) {
        throw new Error(`Existing immutable object has unexpected metadata: ${object.key}`)
      }
      continue
    }
    await client.send(new PutObjectCommand({
      ...params,
      Body: await readFile(join(output, object.key)),
      ContentType: 'application/octet-stream',
      CacheControl: PACKAGE_CACHE_CONTROL,
      Metadata: { sha256: object.sha256 },
      IfNoneMatch: '*'
    }))
    uploaded++
  }
  // Publish the discovery pointer only after every referenced package exists.
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: 'plugins.json',
    Body: await readFile(join(output, 'plugins.json')),
    ContentType: 'application/json; charset=utf-8',
    CacheControl: INDEX_CACHE_CONTROL
  }))
  console.log(`Published ${config.publicBaseUrl}plugins.json (${uploaded} uploaded, ${objects.length - uploaded} unchanged)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployR2().catch(error => { console.error(error.message); process.exitCode = 1 })
}
