// The two sharp pipelines the export engine uses (pages.ts), for a browser worker:
//   sharp(path).ensureAlpha().raw().toBuffer({resolveWithObject})   decode a page to straight RGBA8
//   sharp(rgba,{raw}).png()|.webp(…).toBuffer()                     encode a page
// PNG is decoded and encoded exactly (png.ts). Other sources use the browser's decoder. WebP is encoded
// by libwebp in WebAssembly (@jsquash/webp), with the desktop's settings (method 6, alpha quality 100, lossless),
// so every browser writes WebP; canvas encoding is missing in Safari and premultiplies alpha elsewhere.
import encodeWebpWasm from '@jsquash/webp/encode';
import {memfs} from './memfs';
import {decodePng,encodePng,isPng,type Rgba} from './png';
type Raw={raw:{width:number;height:number;channels:number}};
async function browserDecode(bytes:Uint8Array):Promise<Rgba>{
 const bitmap=await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer]),{premultiplyAlpha:'none',colorSpaceConversion:'none'});
 try{const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(bitmap,0,0);const image=ctx.getImageData(0,0,bitmap.width,bitmap.height);return {width:image.width,height:image.height,data:new Uint8Array(image.data.buffer)};}
 finally{bitmap.close();}
}
async function decodeBytes(bytes:Uint8Array):Promise<Rgba>{return (isPng(bytes)?decodePng(bytes):null)??browserDecode(bytes);}
async function encodeWebp(image:Rgba,quality:number,lossless:boolean):Promise<Uint8Array>{
 const data={data:new Uint8ClampedArray(image.data.buffer as ArrayBuffer,image.data.byteOffset,image.data.byteLength),width:image.width,height:image.height,colorSpace:'srgb'} as ImageData;
 return new Uint8Array(await encodeWebpWasm(data,lossless?{lossless:1,quality:75,method:6,exact:0}:{quality,method:6,alpha_quality:100}));
}
export default function sharp(input:string|Uint8Array,options?:Raw){
 let output:{format:'png'}|{format:'webp';quality:number;lossless:boolean}|null=null;
 const pipeline={
  ensureAlpha:()=>pipeline,raw:()=>pipeline,
  png:()=>{output={format:'png'};return pipeline;},
  webp:(o:{quality?:number;lossless?:boolean}={})=>{output={format:'webp',quality:o.quality??80,lossless:!!o.lossless};return pipeline;},
  async toBuffer(o?:{resolveWithObject?:boolean}){
   if(typeof input==='string'){
    const image=await decodeBytes(memfs.read(input));
    return o?.resolveWithObject?{data:image.data,info:{width:image.width,height:image.height,channels:4}}:image.data;
   }
   if(!options?.raw||options.raw.channels!==4)throw Error('Browser export encodes RGBA pages only');
   const image={width:options.raw.width,height:options.raw.height,data:input};
   if(!output||output.format==='png')return encodePng(image,6);
   return encodeWebp(image,output.quality,output.lossless);
  },
 };
 return pipeline;
}
