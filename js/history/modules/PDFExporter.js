/** 在原 PDF 页面上覆盖正文并按原文字区域排入译文，不重建整张页面。 */
class PDFExporter {
  constructor(options = {}) {
    // 以当前脚本的位置定位资源，兼容工作台和历史记录页。
    const script = typeof document !== 'undefined' && Array.from(document.scripts).find(item => /\/PDFExporter\.js(?:\?|$)/.test(item.src));
    const root = script ? new URL('../../../', script.src).href : '/';
    this.options = Object.assign({
      fontUrl: root + 'public/vendor/NotoSansSC-Regular.ttf',
      pdfLibUrl: root + 'public/vendor/pdf-lib.min.js',
      fontkitUrl: root + 'public/vendor/fontkit.umd.min.js',
      bboxNormalizedRange: 1000,
      minFontSize: 5,
      maxFontSize: 24
    }, options);
  }

  async exportStructuredTranslation(originalPdfBase64, translatedContentList, notify = null, options = {}) {
    try {
      if (!originalPdfBase64 || !Array.isArray(translatedContentList)) throw new Error('缺少原 PDF 或结构化译文，请重新处理原文件。');
      const failed = translatedContentList.filter(item => item && item.type === 'text' && item.failed);
      if (failed.length) throw new Error(`还有 ${failed.length} 段正文翻译失败，请先重试失败段。`);
      const items = translatedContentList.filter(item => item && item.type === 'text' && typeof item.text === 'string' && item.text.trim());
      if (!items.length) throw new Error('没有正文译文可导出。');
      if (notify) notify('正在生成保留页面布局的译文 PDF…', 'info');
      await this.loadPdfLib();
      const doc = await PDFLib.PDFDocument.load(this.base64ToUint8Array(originalPdfBase64));
      doc.registerFontkit(fontkit);
      const response = await fetch(this.options.fontUrl);
      if (!response.ok) throw new Error('中文字体加载失败，请确认 public/vendor/pdf-export 文件夹已上传。');
      // 使用 TrueType 字体，避免 CFF 子集字体在部分阅读器中的兼容性问题。
      // 完整嵌入静态字体，避免多段中文子集的字形映射缺失。
      const font = await doc.embedFont(await response.arrayBuffer(), { subset: false });
      const plans = [];
      const protectedTypes = new Set(['image', 'table', 'formula', 'equation', 'isolate_formula']);
      for (const [index,item] of items.entries()) {
        const pageIndex = item.page_idx;
        const box = item.bbox;
        const range = this.options.bboxNormalizedRange;
        if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.getPageCount() || !Array.isArray(box) || box.length !== 4 ||
          !box.every(Number.isFinite) || box[0] < 0 || box[1] < 0 || box[2] > range || box[3] > range || box[2] <= box[0] || box[3] <= box[1]) {
          throw new Error(`第 ${index+1} 段缺少有效页码或文字坐标，不能可靠地恢复版式。`);
        }
        const page = doc.getPage(pageIndex);
        if (page.getRotation().angle % 360 !== 0) throw new Error(`第 ${pageIndex+1} 页有旋转，请先将原 PDF 页面转正再处理。`);
        // 错误的文字框不应擦掉图、表或独立公式。
        for (const other of translatedContentList) {
          if (!other || other.page_idx !== pageIndex || !protectedTypes.has(other.type) || !Array.isArray(other.bbox)) continue;
          const overlapWidth = Math.min(box[2],other.bbox[2]) - Math.max(box[0],other.bbox[0]);
          const overlapHeight = Math.min(box[3],other.bbox[3]) - Math.max(box[1],other.bbox[1]);
          if (overlapWidth > 1 && overlapHeight > 1) throw new Error(`第 ${pageIndex+1} 页的正文框与图表或公式重叠，已停止导出以避免覆盖原内容。`);
        }
        const size = page.getSize();
        const x = box[0] / range * size.width;
        const top = size.height - box[1] / range * size.height;
        const width = (box[2]-box[0]) / range * size.width;
        const height = (box[3]-box[1]) / range * size.height;
        const text = item.text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').trim();
        const layout = this.calculatePdfTextLayout(font,text,width,height,item.text_level > 0);
        if (!layout.fits) throw new Error(`第 ${pageIndex+1} 页第 ${index+1} 段译文无法完整放入原文字框。请精简译文后重试；本次不会截断文字。`);
        plans.push({page,x,top,width,height,layout});
      }
      // 先验证所有段落，再修改页面，避免部分修改被误下载。
      for (const plan of plans) {
        const {page,x,top,width,height,layout} = plan;
        page.drawRectangle({x,y:top-height,width,height,color:PDFLib.rgb(1,1,1)});
        layout.lines.forEach((line,index) => {
          page.drawText(line, {x:x+layout.padding,y:top-layout.padding-layout.fontSize-index*layout.lineHeight,
            size:layout.fontSize,font,color:PDFLib.rgb(0,0,0)});
        });
      }
      const bytes = await doc.save();
      if (options.download !== false) {
        const filename = options.filename || 'translated.pdf';
        const blob = new Blob([bytes], {type:'application/pdf'});
        if (typeof saveAs === 'function') saveAs(blob,filename);
        else {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href=url; link.download=filename; document.body.appendChild(link); link.click(); link.remove();
          setTimeout(()=>URL.revokeObjectURL(url),1000);
        }
        if (notify) notify('译文 PDF 已导出，请检查复杂公式和段落布局。','success');
      }
      return bytes;
    } catch (error) {
      if (notify) notify('PDF 导出失败：'+error.message,'error');
      if (options.download === false) throw error;
      console.error('[PDFExporter]',error);
      return null;
    }
  }

  calculatePdfTextLayout(font,text,boxWidth,boxHeight,isHeading=false) {
    const padding = Math.min(1,boxHeight*0.03,boxWidth*0.03);
    const availableWidth=boxWidth-padding*2;
    const availableHeight=boxHeight-padding*2;
    const candidate=(size)=>{
      const lines=this.wrapTextForPdf(font,text,availableWidth,size);
      const lineHeight=size*1.25;
      const fits=lines.length*lineHeight <= availableHeight && lines.every(line=>font.widthOfTextAtSize(line,size)<=availableWidth+0.01);
      return {fontSize:size,lines,lineHeight,padding,fits};
    };
    const min=this.options.minFontSize;
    const max=Math.min(this.options.maxFontSize,isHeading?24:12,availableHeight/1.25);
    if (availableWidth<=0 || availableHeight<=0 || min<=0 || max<min) return {fits:false};
    let best=candidate(min);
    if (!best.fits) return best;
    let low=min,high=Math.max(min,max);
    for (let step=0;step<18 && high-low>0.02;step++) {
      const mid=(low+high)/2;
      const trial=candidate(mid);
      if (trial.fits) {best=trial;low=mid;} else high=mid;
    }
    return best;
  }

  wrapTextForPdf(font,text,maxWidth,fontSize) {
    const lines=[];
    for (const paragraph of text.split('\n')) {
      let line='';
      for (const char of Array.from(paragraph)) {
        if (line && font.widthOfTextAtSize(line+char,fontSize)>maxWidth) {
          // 西文优先在词间换行；中文按字符换行。
          const space=line.lastIndexOf(' ');
          if (/^[\x20-\x7e]+$/.test(line+char) && space>0) {
            lines.push(line.slice(0,space));
            line=line.slice(space+1)+char;
          } else {lines.push(line);line=char;}
        } else line+=char;
      }
      lines.push(line);
    }
    return lines;
  }

  async loadPdfLib() {
    if (typeof PDFLib === 'undefined') await this.loadScript(this.options.pdfLibUrl,'PDFLib');
    // 即使 PDFLib 已加载，也必须单独检查 fontkit。
    if (typeof fontkit === 'undefined') await this.loadScript(this.options.fontkitUrl,'fontkit');
  }

  loadScript(url,globalName) {
    PDFExporter.scriptLoads=PDFExporter.scriptLoads || new Map();
    if (!PDFExporter.scriptLoads.has(url)) {
      const promise=new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        script.src=url;
        script.onload=()=>window[globalName] ? resolve() : reject(new Error(globalName+' 加载异常'));
        script.onerror=()=>reject(new Error(globalName+' 加载失败，请检查更新文件'));
        document.head.appendChild(script);
      }).catch(error=>{PDFExporter.scriptLoads.delete(url);throw error;});
      PDFExporter.scriptLoads.set(url,promise);
    }
    return PDFExporter.scriptLoads.get(url);
  }

  base64ToUint8Array(base64) {
    const binary=atob(base64.replace(/^data:application\/pdf;base64,/,''));
    return Uint8Array.from(binary,char=>char.charCodeAt(0));
  }
}
if (typeof window !== 'undefined') window.PDFExporter=PDFExporter;
if (typeof module !== 'undefined' && module.exports) module.exports=PDFExporter;
