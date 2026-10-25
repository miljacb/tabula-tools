// node:os / url / util / crypto / child_process / module for the export engine in a browser worker.
// Only KTX2 (the native `ktx` tool and its cache) needs these for real, and KTX2 is desktop-only:
// the worker passes its own `encodeKtx2`, so these are never called on a supported path.
const unavailable=(name:string)=>()=>{throw Error(`${name} needs the desktop app (KTX2 encoding runs the native ktx tool)`);};
export const tmpdir=()=>'/tmp';
export const fileURLToPath=(url:string|URL)=>new URL(String(url)).pathname;
export const promisify=<T extends (...args:never[])=>unknown>(fn:T)=>fn;
export const execFile=unavailable('ktx'),execFileSync=unavailable('ktx'),spawn=unavailable('ktx');
export const createHash=unavailable('KTX2 cache'),createRequire=unavailable('require');
