import { parseFile, textChunks } from './parsers.js';
export async function parseMaterial(name:string,bytes:Buffer) {
  if(/\.(txt|md)$/i.test(name)) {
    if(bytes.length>8*1024*1024) throw new Error('材料超过8 MiB，请拆分后重新上传。');
    const chunks=textChunks(bytes.toString('utf8'));
    if(!chunks.length) throw new Error('材料没有可读取文字，请提供包含正文的文本文件。');
    return {id:'',name,chunks,warnings:[],characters:chunks.reduce((n,c)=>n+c.text.length,0)};
  }
  return parseFile({name,size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
}
