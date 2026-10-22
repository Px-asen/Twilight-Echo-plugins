import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root='.cache/visual-reference';
const labels=['downloads-0.2.9','optimized-0.2.11','restored-0.2.13'];
const meta=await Promise.all(labels.map(l=>readFile(`${root}/${l}/result.json`,'utf8').then(JSON.parse)));
const diffs=[];
for(let row=0;row<4;row++){
  const {theme,scenario}=meta[0].rows[row];
  const crop=scenario==='archive'?{left:90,top:270,width:1150,height:690}:{left:90,top:180,width:1150,height:1000};
  const images=await Promise.all(labels.map(l=>sharp(`${root}/${l}/${theme}-${scenario}.png`).extract(crop).removeAlpha().raw().toBuffer()));
  const metrics=images.slice(1).map((b,i)=>{
    const a=images[0];let sum=0,max=0,n=0;
    for(let j=0;j<a.length;j++){const d=Math.abs(a[j]-b[j]);sum+=d;max=Math.max(max,d);n+=d>8;}
    return{version:labels[i+1],mean:sum/a.length,max,over8:n/a.length};
  });
  for(const v of meta.slice(1))for(const key of ['modelPosition','cameraPosition','cameraAim','fieldOfView'])
    assert.deepEqual(v.rows[row].stats[key],meta[0].rows[row].stats[key],'Camera '+key);
  assert.equal(meta[2].rows[row].quality.width,meta[0].rows[row].quality.width);
  assert.equal(meta[2].rows[row].quality.height,meta[0].rows[row].quality.height);
  assert.equal(meta[2].rows[row].stats.renderTiers.medium+meta[2].rows[row].stats.renderTiers.far,0);
  diffs.push({theme,scenario,metrics});
  const chunks=[];
  for(let i=0;i<labels.length;i++){
    const data=await sharp(`${root}/${labels[i]}/${theme}-${scenario}.png`).extract({left:250,top:scenario==='archive'?360:320,width:600,height:650}).png().toBuffer();
    chunks.push({input:data,left:600*i,top:40});
    chunks.push({input:Buffer.from(`<svg width="600" height="40"><rect width="100%" height="100%" fill="white"/><text x="10" y="27" font-family="Arial" font-size="23">${labels[i]}</text></svg>`),left:600*i,top:0});
  }
  await sharp({create:{width:1800,height:690,channels:4,background:'#fff'}}).composite(chunks).png().toFile(`${root}/comparison-${theme}-${scenario}.png`);
}
await writeFile(`${root}/comparison.json`,JSON.stringify(diffs,null,2));
console.log(JSON.stringify(diffs,null,2));
