import fs from './fs.js'

export const {
  readFile,
  writeFile,
  appendFile,
  mkdir,
  readdir,
  stat,
  lstat,
  unlink,
  rm,
  rmdir,
  rename,
  copyFile,
  access,
  realpath,
  mkdtemp,
  open
} = fs.promises

export const constants = fs.constants

export default fs.promises
