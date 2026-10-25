// PNG decode/encode to straight-alpha RGBA8 without a canvas: canvases premultiply, which loses
// colour in soft edges, and the engine's pages and repacking need the exact stored pixels.
import {unzlibSync,zlibSync} from 'fflate';
export type Rgba={width:number;height:number;data:Uint8Array};
const SIGNATURE=[137,80,78,71,13,10,26,10];
export const isPng=(bytes:Uint8Array)=>bytes.length>8&&SIGNATURE.every((v,i)=>bytes[i]===v);
const paeth=(a:number,b:number,c:number)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
/** Decode a non-interlaced PNG (any colour type, 1-16 bit) to RGBA8; null when interlaced (callers fall back to the browser decoder). */
export function decodePng(bytes:Uint8Array):Rgba|null{
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),idat:Uint8Array[]=[];
 let width=0,height=0,depth=0,type=0,interlace=0,palette:Uint8Array|null=null,trns:Uint8Array|null=null;
 for(let at=8;at+8<=bytes.length;){
  const length=view.getUint32(at),name=String.fromCharCode(...bytes.subarray(at+4,at+8)),data=bytes.subarray(at+8,at+8+length);at+=12+length;
  if(name==='IHDR'){width=view.getUint32(16);height=view.getUint32(20);depth=data[8];type=data[9];interlace=data[12];}
  else if(name==='PLTE')palette=data;else if(name==='tRNS')trns=data;else if(name==='IDAT')idat.push(data);else if(name==='IEND')break;
 }
 if(!width||!height)throw Error('Invalid PNG');if(interlace)return null;
 let total=0;for(const c of idat)total+=c.length;const packed=new Uint8Array(total);total=0;for(const c of idat){packed.set(c,total);total+=c.length;}
 const raw=unzlibSync(packed),channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[type];if(!channels)throw Error(`Unsupported PNG colour type ${type}`);
 const bitsPerPixel=channels*depth,stride=Math.ceil(width*bitsPerPixel/8),bpp=Math.max(1,bitsPerPixel>>3),lines=new Uint8Array(stride*height);
 for(let y=0,src=0;y<height;y++){
  const filter=raw[src++],line=lines.subarray(y*stride,(y+1)*stride),prev=y?lines.subarray((y-1)*stride,y*stride):null;
  for(let x=0;x<stride;x++){
   const v=raw[src++],a=x>=bpp?line[x-bpp]:0,b=prev?prev[x]:0,c=prev&&x>=bpp?prev[x-bpp]:0;
   line[x]=filter===0?v:filter===1?v+a:filter===2?v+b:filter===3?v+((a+b)>>1):filter===4?v+paeth(a,b,c):(()=>{throw Error(`Invalid PNG filter ${filter}`);})();
  }
 }
 const out=new Uint8Array(width*height*4),max=(1<<depth)-1;
 const sample=(line:Uint8Array,index:number)=>depth===8?line[index]:depth===16?line[index*2]:(line[(index*depth)>>3]>>(8-depth-((index*depth)&7)))&max;
 const scale=(v:number)=>depth===16||depth===8?v:Math.round(v*255/max);
 const key=trns&&(type===0||type===2)?Array.from({length:type===0?1:3},(_,i)=>(trns![i*2]<<8)|trns![i*2+1]):null;
 const wide=(line:Uint8Array,index:number)=>depth===16?(line[index*2]<<8)|line[index*2+1]:sample(line,index);
 for(let y=0;y<height;y++){
  const line=lines.subarray(y*stride,(y+1)*stride);
  for(let x=0;x<width;x++){
   const o=(y*width+x)*4,i=x*channels;
   if(type===3){const p=sample(line,x);out[o]=palette![p*3];out[o+1]=palette![p*3+1];out[o+2]=palette![p*3+2];out[o+3]=trns&&p<trns.length?trns[p]:255;continue;}
   const g=scale(sample(line,i));
   if(type===0){out[o]=out[o+1]=out[o+2]=g;out[o+3]=key&&wide(line,i)===key[0]?0:255;}
   else if(type===4){out[o]=out[o+1]=out[o+2]=g;out[o+3]=sample(line,i+1);}
   else{out[o]=g;out[o+1]=sample(line,i+1);out[o+2]=sample(line,i+2);out[o+3]=type===6?sample(line,i+3):key&&wide(line,i)===key[0]&&wide(line,i+1)===key[1]&&wide(line,i+2)===key[2]?0:255;}
  }
 }
 return {width,height,data:out};
}
const CRC=new Uint32Array(256).map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function chunk(name:string,data:Uint8Array){
 const out=new Uint8Array(12+data.length),view=new DataView(out.buffer);view.setUint32(0,data.length);for(let i=0;i<4;i++)out[4+i]=name.charCodeAt(i);out.set(data,8);
 let c=~0;for(let i=4;i<8+data.length;i++)c=CRC[(c^out[i])&255]^(c>>>8);view.setUint32(8+data.length,~c>>>0);return out;
}
/** Encode RGBA8 as a PNG, choosing each row's filter by the minimum-sum heuristic (as libpng's adaptive filtering). */
export function encodePng({width,height,data}:Rgba,level:0|1|2|3|4|5|6|7|8|9=6):Uint8Array{
 const stride=width*4,raw=new Uint8Array((stride+1)*height),candidates=Array.from({length:5},()=>new Uint8Array(stride));
 for(let y=0;y<height;y++){
  const line=data.subarray(y*stride,(y+1)*stride),prev=y?data.subarray((y-1)*stride,y*stride):null;let best=0,bestSum=Infinity;
  for(let f=0;f<5;f++){
   const row=candidates[f];let sum=0;
   for(let x=0;x<stride;x++){const v=line[x],a=x>=4?line[x-4]:0,b=prev?prev[x]:0,c=prev&&x>=4?prev[x-4]:0;const r=(f===0?v:f===1?v-a:f===2?v-b:f===3?v-((a+b)>>1):v-paeth(a,b,c))&255;row[x]=r;sum+=r<128?r:256-r;if(sum>=bestSum)break;}
   if(sum<bestSum){bestSum=sum;best=f;}
  }
  // The early exit leaves losing rows partial: recompute the winner in full.
  const row=candidates[best];for(let x=0;x<stride;x++){const v=line[x],a=x>=4?line[x-4]:0,b=prev?prev[x]:0,c=prev&&x>=4?prev[x-4]:0;row[x]=(best===0?v:best===1?v-a:best===2?v-b:best===3?v-((a+b)>>1):v-paeth(a,b,c))&255;}
  raw[y*(stride+1)]=best;raw.set(row,y*(stride+1)+1);
 }
 const header=new Uint8Array(13),view=new DataView(header.buffer);view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=6;
 const parts=[new Uint8Array(SIGNATURE),chunk('IHDR',header),chunk('IDAT',zlibSync(raw,{level})),chunk('IEND',new Uint8Array(0))];
 const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;
}
