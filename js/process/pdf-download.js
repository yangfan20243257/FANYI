// PDF 下载：优先结构化译文；普通翻译结果也可重排生成正文 PDF。
(function(global) {
  let exporterPromise;
  function getMetadata(result) {return result?.metadata||{};}
  function structuredItems(result) {
    const list=getMetadata(result).translatedContentList;
    return Array.isArray(list)?list.filter(item=>item && ((typeof item.text==='string'&&item.text.trim()) || (typeof item.content==='string'&&item.content.trim()) || ['image','table','formula','equation','isolate_formula'].includes(item.type))):[];
  }
  function plainTranslation(result) {
    if(typeof result?.translation==='string'&&result.translation.trim())return result.translation.trim();
    if(Array.isArray(result?.translatedChunks))return result.translatedChunks.map(chunk=>typeof chunk==='string'?chunk:chunk?.translatedText||chunk?.translation||chunk?.translated||chunk?.text||'').filter(value=>typeof value==='string'&&value.trim()).join('\n\n');
    return '';
  }
  function isReady(result) {return !!(result&&!result.skipped&&(structuredItems(result).length||plainTranslation(result)));}
  async function loadExporter() {
    if(typeof global.PDFExporter==='function')return global.PDFExporter;
    if(!exporterPromise)exporterPromise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='js/history/modules/PDFExporter.js';
      script.onload=()=>typeof global.PDFExporter==='function'?resolve(global.PDFExporter):reject(new Error('PDF 导出模块未正确加载'));
      script.onerror=()=>reject(new Error('PDF 导出模块加载失败，请确认已上传 PDFExporter.js'));
      document.head.appendChild(script);
    }).catch(error=>{exporterPromise=null;throw error;});
    return exporterPromise;
  }
  function asBase64(bytes) {
    const array=new Uint8Array(bytes);let binary='';
    for(let index=0;index<array.length;index+=32768)binary+=String.fromCharCode(...array.subarray(index,index+32768));
    return btoa(binary);
  }
  async function originalBase64(result,exporter,needed,blank=false) {
    const metadata=getMetadata(result);
    if(!blank&&metadata.originalPdfBase64)return metadata.originalPdfBase64;
    if(!blank&&(result.originalExtension==='pdf'||result.originalEncoding==='pdf'||result.fileType==='pdf')&&typeof result.originalBinary==='string'&&result.originalBinary)return result.originalBinary;
    if(!blank&&result.file&&typeof result.file.arrayBuffer==='function'&&/\.pdf$/i.test(result.file.name||''))return asBase64(await result.file.arrayBuffer());
    // 没有原 PDF 时，仍可将译文排成新的 PDF；不假装恢复了原图表。
    await exporter.loadPdfLib();
    const doc=await global.PDFLib.PDFDocument.create();
    const pages=needed?Math.min(5000,Math.max(1,...needed.map(item=>Number.isInteger(item.page_idx)&&item.page_idx>=0?item.page_idx+1:1))):1;
    for(let i=0;i<pages;i++)doc.addPage();
    return asBase64(await doc.save());
  }
  function readableMarkdown(text) {
    return text.replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/\*\*([^*]+)\*\*/g,'$1').replace(/```[^\n]*\n?/g,'');
  }
  async function generate(result) {
    const Exporter=await loadExporter(),exporter=new Exporter();
    let items=structuredItems(result),fallback=false;
    if(!items.length) {
      const text=plainTranslation(result);if(!text)throw new Error('没有可用译文，请先完成翻译；仅有 OCR 原文不能生成译文 PDF。');
      items=[{type:'text',text:readableMarkdown(text),page_idx:0,bbox:[0,0,1000,1000]}];fallback=true;
    }
    const original=await originalBase64(result,exporter,items,fallback);
    if((fallback||!getMetadata(result).originalPdfBase64)&&typeof global.showNotification==='function')global.showNotification(fallback?'本次为普通翻译结果，将生成正文重排 PDF；原图表版式未恢复。':'正在生成译文 PDF…','info');
    return exporter.exportStructuredTranslation(original,items,null,{download:false});
  }
  async function downloadPdfResults(results) {
    const ready=(results||[]).filter(isReady);
    if(!ready.length)throw new Error('当前没有可下载的译文结果。若刷新过页面，请从历史记录打开已完成结果，或重新上传文件并完成翻译。');
    const outputs=[],errors=[];
    for(const result of ready) {
      const base=result.file?.name||result.relativePath||result.name||'document';
      const safe=typeof sanitizeFileName==='function'?sanitizeFileName(typeof removeExtension==='function'?removeExtension(base):base.replace(/\.[^.]+$/,'')):base.replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|]/g,'_');
      try {outputs.push({name:safe+'-translated.pdf',bytes:await generate(result)});}
      catch(error){errors.push(base+'：'+error.message);}
    }
    if(!outputs.length)throw new Error(errors.join('；')||'没有可生成的译文 PDF');
    if(outputs.length===1)saveAs(new Blob([outputs[0].bytes],{type:'application/pdf'}),outputs[0].name);
    else {
      if(typeof JSZip==='undefined')throw new Error('ZIP 模块未加载');
      const zip=new JSZip();outputs.forEach((output,index)=>zip.file(`${index+1}-${output.name}`,output.bytes));
      saveAs(await zip.generateAsync({type:'blob'}),'translated-pdfs.zip');
    }
    if(typeof global.showNotification==='function')global.showNotification(errors.length?`已生成 ${outputs.length} 个 PDF；${errors.join('；')}`:`已生成 ${outputs.length} 个译文 PDF。`,errors.length?'warning':'success');
  }
  global.PdfResultDownload={isReady,generate,downloadPdfResults};
})(window);
