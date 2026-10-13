// Server adapter of the existing material parser; limits and source locations preserved.
import {DOMParser} from '@xmldom/xmldom';
import {unzipSync,strFromU8} from 'fflate';
export const MAX_FILE=8*1024*1024, MAX_CSV_ROWS=10000, MAX_SHEET_ROWS=10000, MAX_XLSX_COLUMNS=16384, MAX_XLSX_DECODED_CELLS=2000000, MAX_PDF_PAGES=2000;
const xml=s=>{let invalid=false;const d=new DOMParser({onError:()=>{invalid=true;}}).parseFromString(s,'application/xml');if(invalid)throw Error('文档 XML 无法读取，请另存为标准 Office 文件。');return d;};
const uid=()=>globalThis.crypto?.randomUUID?.()||'doc-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
const all=(d,n)=>Array.from(d.getElementsByTagNameNS('*',n));
export function textChunks(text,label='段落') {
  const chunks=[];
  for(const line of text.replace(/\r\n?/g,'\n').split(/\n+/)){const t=line.trim();if(!t)continue;for(let i=0;i<t.length;i+=700)chunks.push({location:`${label} ${chunks.length+1}`,text:t.slice(i,i+700)});}
  return chunks;
}
export function parseCSV(text,delimiter=',') {
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted||cell===''){quoted=!quoted;}else cell+=c;}
    else if(c===delimiter&&!quoted){row.push(cell);cell='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x!==''))rows.push(row);row=[];cell='';}
    else cell+=c;
    if(rows.length>MAX_CSV_ROWS)throw Error(`表格行数超过 ${MAX_CSV_ROWS.toLocaleString('zh-CN')}，请拆分后再上传。`);
  }
  if(quoted)throw Error('CSV 引号没有闭合，请检查文件。');
  row.push(cell);if(row.some(x=>x!==''))rows.push(row);if(rows.length>MAX_CSV_ROWS)throw Error(`表格行数超过 ${MAX_CSV_ROWS.toLocaleString('zh-CN')}，请拆分后再上传。`);return rows;
}
function spreadsheetChunks(rows,label) {
  if(!rows.length)return [];
  const header=rows[0].map((x,i)=>String(x||`列${i+1}`));
  return [{location:`${label} / 表头`,text:header.join(' | ')},...rows.slice(1).map((r,i)=>({location:`${label} / 第 ${i+2} 行`,text:r.flatMap((v,j)=>v===''?[]:[`${header[j]||'列'+(j+1)}：${v}`]).join('；')})).filter(chunk=>chunk.text)];
}
function officeEntries(bytes) {
  let total=0,count=0;
  return unzipSync(bytes,{filter:f=>{
    if(++count>3000)throw Error('文档内部文件过多，请上传较小样本。');
    if(!/^(word\/document.xml|xl\/(sharedStrings.xml|workbook.xml|_rels\/workbook.xml.rels|worksheets\/sheet\d+.xml)|ppt\/slides\/slide\d+.xml)$/.test(f.name))return false;
    total+=f.originalSize;
    if(f.originalSize>6*1024*1024||total>16*1024*1024)throw Error('文档解压后过大，请截取样本后再上传。');
    return true;
  }});
}
export async function parseFile(file) {
  if(file.size>MAX_FILE)throw Error('单个文件不能超过 8 MB。');
  const ext=file.name.split('.').pop().toLowerCase();
  const bytes=new Uint8Array(await file.arrayBuffer());
  let chunks=[],warnings=[];
  if(['csv','tsv'].includes(ext)) {
    let text=new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/,'');
    if(text.includes('\uFFFD')){text=new TextDecoder('gb18030').decode(bytes);warnings.push('已尝试按 GB18030 解码，请核对中文是否正常。');}
    const rows=parseCSV(text,ext==='tsv'?'\t':',');chunks=spreadsheetChunks(rows,'表格');
  } else if(['docx','xlsx','pptx'].includes(ext)) {
    const entries=officeEntries(bytes);
    const get=p=>{if(!entries[p])throw Error('文件结构不完整，可能不是有效的 Office 文档。');return xml(strFromU8(entries[p]));};
    if(ext==='docx'){
      chunks=all(get('word/document.xml'),'p').map((p,i)=>({location:`段落 ${i+1}`,text:all(p,'t').map(x=>x.textContent).join('')})).filter(x=>x.text.trim());
      warnings.push('提取正文及表格文字；图片、批注、页眉页脚不纳入分析。');
    }else if(ext==='xlsx'){
      const shared=entries['xl/sharedStrings.xml']?all(get('xl/sharedStrings.xml'),'si').map(s=>all(s,'t').map(t=>t.textContent).join('')):[];
      const rels=entries['xl/_rels/workbook.xml.rels']?all(get('xl/_rels/workbook.xml.rels'),'Relationship'):[];
      const sheets=entries['xl/workbook.xml']?all(get('xl/workbook.xml'),'sheet'):[];
      const paths=Object.keys(entries).filter(p=>p.startsWith('xl/worksheets/')).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
      if(!paths.length)throw Error('没有找到可读取的工作表。');
      let decodedCells=0;
      for(const path of paths){
        const rel=rels.find(r=>('xl/'+(r.getAttribute('Target')||'').replace(/^\/?xl\//,'').replace(/^\//,''))===path);
        const name=sheets.find(s=>s.getAttribute('r:id')===rel?.getAttribute('Id'))?.getAttribute('name')||path.split('/').pop();
        const rows=all(get(path),'row');
        if(rows.length>MAX_SHEET_ROWS)throw Error(`工作表“${name}”超过 ${MAX_SHEET_ROWS.toLocaleString('zh-CN')} 行，请拆分后再上传。`);
        const values=rows.map(row=>{
          const cells=[];
          for(const c of all(row,'c')){
            const ref=c.getAttribute('r')||'',match=/^([A-Z]+)([1-9]\d*)$/.exec(ref);if(!match)throw Error('工作表单元格引用无效，请另存为标准 XLSX 后重试。');
            let idx=0;for(const a of match[1]){const value=a.charCodeAt(0)-64;if(idx>Math.floor((MAX_XLSX_COLUMNS-value)/26))throw Error(`工作表列数超过 XLSX 的 ${MAX_XLSX_COLUMNS.toLocaleString('zh-CN')} 列限制，请拆分后再上传。`);idx=idx*26+value;}idx--;
            const value=all(c,'v')[0]?.textContent||'';
            cells[idx]=c.getAttribute('t')==='s'?(shared[Number(value)]||''):c.getAttribute('t')==='inlineStr'?all(c,'t').map(t=>t.textContent).join(''):value;
          }if(decodedCells+cells.length>MAX_XLSX_DECODED_CELLS)throw Error(`工作簿展开后的单元格范围超过 ${MAX_XLSX_DECODED_CELLS.toLocaleString('zh-CN')} 格，请拆分后再上传。`);decodedCells+=cells.length;return Array.from(cells,v=>v??'');
        });
        chunks.push(...spreadsheetChunks(values,`工作表 ${name}`));
      }
      warnings.push('读取全部工作表的单元格文本和公式缓存值，不执行公式；日期可能显示为 Excel 序列值。');
    }else {
      const paths=Object.keys(entries).filter(p=>p.startsWith('ppt/slides/')).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
      if(!paths.length)throw Error('没有找到可读取的幻灯片。');
      chunks=paths.flatMap((path,index)=>textChunks(all(get(path),'t').map(node=>node.textContent).join('\n'),`幻灯片 ${index+1} / 摘录`));
      warnings.push('提取幻灯片文字；图片、讲稿备注、动画和嵌入对象不纳入分析。');
    }
  } else if(ext==='pdf') {
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task=pdfjs.getDocument({data:bytes,isEvalSupported:false,useSystemFonts:true,disableFontFace:true});
    let pdf;try{
      pdf=await task.promise;
      if(pdf.numPages>MAX_PDF_PAGES)throw Error(`PDF 超过 ${MAX_PDF_PAGES.toLocaleString('zh-CN')} 页，请拆分后再上传。`);
      for(let n=1;n<=pdf.numPages;n++){
        const page=await pdf.getPage(n);const content=await page.getTextContent();
        const text=content.items.map(x=>x.str+(x.hasEOL?'\n':' ')).join('');
        chunks.push(...textChunks(text,`第 ${n} 页 / 摘录`));
      }
      warnings.push('仅提取文字层，不识别扫描图片；复杂表格阅读顺序需核对。');
    }finally{await task.destroy();}
  } else throw Error('暂不支持此格式。请使用 CSV、TSV、DOCX、XLSX、PPTX 或文字 PDF；旧版 DOC、XLS、PPT 及 WPS、ET、DPS 请先另存为这些格式。');
  const characters=chunks.reduce((total,chunk)=>total+chunk.text.length,0);
  if(!chunks.some(c=>c.text.trim().length>2))throw Error('未提取到有效文字。扫描 PDF 可通过图片识别预览继续；图片或受保护文档请转成文字后再粘贴内容。');
  return {id:uid(),name:file.name,chunks,characters,warnings:[...new Set(warnings)]};
}
