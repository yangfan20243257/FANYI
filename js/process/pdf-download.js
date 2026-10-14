// 工作台的 PDF 下载入口。仅使用有原始 PDF 和逐块坐标的结构化结果。
(function(global) {
  let exporterPromise;
  function getMetadata(result) { return result && result.metadata || {}; }
  function isReady(result) {
    const metadata = getMetadata(result);
    return result && !result.error && !result.skipped && metadata.originalPdfBase64 &&
      Array.isArray(metadata.translatedContentList) && metadata.translatedContentList.some(item =>
        item && item.type === 'text' && !item.failed && typeof item.text === 'string' && item.text.trim() && Array.isArray(item.bbox));
  }
  async function loadExporter() {
    if (typeof global.PDFExporter === 'function') return global.PDFExporter;
    if (!exporterPromise) {
      exporterPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'js/history/modules/PDFExporter.js';
        script.onload = () => typeof global.PDFExporter === 'function' ? resolve(global.PDFExporter) : reject(new Error('PDF 导出模块未正确加载'));
        script.onerror = () => reject(new Error('PDF 导出模块加载失败，请确认已上传全部更新文件'));
        document.head.appendChild(script);
      }).catch(error => { exporterPromise = null; throw error; });
    }
    return exporterPromise;
  }
  async function generate(result) {
    const Exporter = await loadExporter();
    const metadata = getMetadata(result);
    return new Exporter().exportStructuredTranslation(metadata.originalPdfBase64, metadata.translatedContentList, null, { download: false });
  }
  async function downloadPdfResults(results) {
    const ready = (results || []).filter(isReady);
    if (!ready.length) throw new Error('缺少原始 PDF 或段落坐标。请选择 MinerU → 结构化翻译模式，重新处理原 PDF 后再下载。');
    const outputs = [];
    for (const result of ready) {
      const name = sanitizeFileName(removeExtension(result.file?.name || result.relativePath || 'document')) + '-translated.pdf';
      const bytes = await generate(result);
      outputs.push({ name, bytes });
    }
    if (outputs.length === 1) {
      saveAs(new Blob([outputs[0].bytes], {type:'application/pdf'}), outputs[0].name);
    } else {
      if (typeof JSZip === 'undefined') throw new Error('ZIP 模块未加载');
      const zip = new JSZip();
      outputs.forEach((output,index) => zip.file(`${index+1}-${output.name}`,output.bytes));
      saveAs(await zip.generateAsync({type:'blob'}),'translated-pdfs.zip');
    }
    const omitted = (results || []).filter(result => result && !result.error && !result.skipped).length - ready.length;
    showNotification(omitted ? `已生成 ${ready.length} 个 PDF；另有 ${omitted} 个结果缺少版式数据，请用 MinerU 结构化模式重新处理。` : '译文 PDF 已生成，请检查页面排版。', omitted ? 'warning' : 'success');
  }
  global.PdfResultDownload = { isReady, generate, downloadPdfResults };
})(window);
