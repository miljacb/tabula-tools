// POSIX node:path subset for the export engine in a browser worker (the in-memory disk is rooted at /).
export const sep='/';
export function normalize(path:string){
 const absolute=path.startsWith('/'),out:string[]=[];
 for(const part of path.split('/')){if(!part||part==='.')continue;if(part==='..'){if(out.length&&out.at(-1)!=='..')out.pop();else if(!absolute)out.push('..');}else out.push(part);}
 return (absolute?'/':'')+out.join('/')||(absolute?'/':'.');
}
export const join=(...parts:string[])=>normalize(parts.filter(Boolean).join('/'));
export const isAbsolute=(path:string)=>path.startsWith('/');
export function resolve(...parts:string[]){let path='';for(const part of parts)path=part.startsWith('/')?part:`${path}/${part}`;return normalize(path.startsWith('/')?path:'/'+path);}
export function dirname(path:string){const n=normalize(path),i=n.lastIndexOf('/');return i<0?'.':i===0?'/':n.slice(0,i);}
export function basename(path:string,ext?:string){const name=normalize(path).split('/').pop()??'';return ext&&name.endsWith(ext)&&name!==ext?name.slice(0,-ext.length):name;}
export function extname(path:string){const name=basename(path),i=name.lastIndexOf('.');return i<=0?'':name.slice(i);}
export function relative(from:string,to:string){
 const a=resolve(from).split('/').filter(Boolean),b=resolve(to).split('/').filter(Boolean);let i=0;while(i<a.length&&i<b.length&&a[i]===b[i])i++;
 return [...a.slice(i).map(()=>'..'),...b.slice(i)].join('/');
}
export const posix={sep,normalize,join,isAbsolute,resolve,dirname,basename,extname,relative};
export default posix;
