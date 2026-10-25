// Node globals the export engine touches, for a browser worker. Imported first by worker.ts so they
// exist before the engine's modules evaluate.
const scope=globalThis as unknown as Record<string,unknown>;
// Buffer.from(arrayBuffer, offset, length): pages.ts wraps RGBA for sharp; a view is all it needs.
scope.Buffer??={from:(data:ArrayBufferLike,offset?:number,length?:number)=>new Uint8Array(data,offset,length)};
scope.process??={env:{TABULA_KTX_DOWNLOAD:'0'},platform:'browser',arch:'wasm'};
// setImmediate: the engine yields between steps so progress reaches the page; a MessageChannel
// task avoids the 4 ms clamp nested setTimeout(0) gets.
if(!scope.setImmediate){
 const channel=new MessageChannel(),queue:(()=>void)[]=[];
 channel.port1.onmessage=()=>queue.shift()?.();
 scope.setImmediate=(fn:()=>void)=>{queue.push(fn);channel.port2.postMessage(0);};
}
export {};
