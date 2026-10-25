// In-memory stand-in for node:fs and node:fs/promises, for the export engine in a browser worker.
// Only what the engine calls: files in a Map, folders implied by paths. Anything else throws.
import {normalize} from './path';
const files=new Map<string,Uint8Array>();
const encoder=new TextEncoder(),decoder=new TextDecoder();
const key=(path:string)=>normalize(String(path)).replace(/\/+$/,'')||'/';
const enoent=(path:string)=>Object.assign(Error(`ENOENT: no such file or directory, '${path}'`),{code:'ENOENT'});
const isDir=(dir:string)=>{const prefix=dir==='/'?'/':dir+'/';for(const name of files.keys())if(name.startsWith(prefix))return true;return false;};
type Bytes=Uint8Array|ArrayBuffer|string;
const bytes=(data:Bytes)=>typeof data==='string'?encoder.encode(data):data instanceof Uint8Array?data:new Uint8Array(data);
/** Engine I/O for the worker (not part of node:fs). */
export const memfs={
 write(path:string,data:Bytes){files.set(key(path),bytes(data));},
 read(path:string){const data=files.get(key(path));if(!data)throw enoent(path);return data;},
 /** Files under `dir`, relative, sorted. */
 list(dir:string){const prefix=key(dir)+'/';return [...files.keys()].filter(n=>n.startsWith(prefix)).map(n=>n.slice(prefix.length)).sort();},
 clear(){files.clear();},
};
class Dirent{constructor(readonly name:string,private dir:boolean){}isDirectory(){return this.dir;}isFile(){return !this.dir;}}
class Stats{constructor(readonly size:number,private dir:boolean){}isDirectory(){return this.dir;}isFile(){return !this.dir;}}
export function existsSync(path:string){const k=key(path);return files.has(k)||isDir(k);}
export async function readFile(path:string,options?:string|{encoding?:string}){const data=memfs.read(path),encoding=typeof options==='string'?options:options?.encoding;return encoding?decoder.decode(data):data;}
export async function writeFile(path:string,data:Bytes){memfs.write(path,data);}
export async function mkdir(){return undefined;}
export async function stat(path:string){const k=key(path),data=files.get(k);if(data)return new Stats(data.length,false);if(isDir(k))return new Stats(0,true);throw enoent(path);}
export async function readdir(path:string,options?:{withFileTypes?:boolean}){
 const k=key(path),prefix=k==='/'?'/':k+'/',seen=new Map<string,boolean>();
 for(const name of files.keys())if(name.startsWith(prefix)){const rest=name.slice(prefix.length),slash=rest.indexOf('/');seen.set(slash<0?rest:rest.slice(0,slash),slash>=0||seen.get(rest)===true);}
 if(!seen.size&&!files.has(k))throw enoent(path);
 const names=[...seen.keys()].sort();return options?.withFileTypes?names.map(n=>new Dirent(n,seen.get(n)!)):names;
}
export async function rm(path:string){const k=key(path),prefix=k+'/';files.delete(k);for(const name of [...files.keys()])if(name.startsWith(prefix))files.delete(name);}
const unavailable=(name:string)=>async()=>{throw Error(`${name} is not available in the browser export`);};
export const mkdtemp=unavailable('mkdtemp'),chmod=unavailable('chmod'),copyFile=unavailable('copyFile'),rename=unavailable('rename'),symlink=unavailable('symlink');
