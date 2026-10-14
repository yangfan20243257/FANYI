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
      compactMinFontSize: 4.5,
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
      if (!response.ok) throw new Error('中文字体加载失败，请确认 public/vendor 文件夹已上传。');
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
        const top = size.height - box[1] / range * size.height;
        const height = (box[3]-box[1]) / range * size.height;
        const text = item.text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').trim();
        const heading = item.text_level > 0;
        const preferred = heading ? 18 : 10.5;
        let x = box[0] / range * size.width;
        let width = (box[2]-box[0]) / range * size.width;
        let layout = this.calculatePdfTextLayout(font,text,width,height,heading,true,preferred);
        if (!layout.fits || layout.fontSize < preferred*0.95) {
          const expanded = this.expandHorizontalBox(item,translatedContentList,size,plans);
          x=expanded.x; width=expanded.width;
          layout=this.calculatePdfTextLayout(font,text,width,height,heading,true,preferred);
        }
        if (!layout.fits) layout=this.calculatePdfTextLayout(font,text,width,height,heading,true,preferred,true);
        plans.push({page,pageIndex,x,top,width,height,layout,text,heading});
      }
      // 正文共享字号基准，常规段落字号差异约 15%；极拥挤段落允许更小字号，优先保留完整译文。
      const bodyPlans=plans.filter(plan=>!plan.heading && plan.layout.fontSize>=this.options.compactMinFontSize);
      const commonSize=bodyPlans.length ? Math.min(10.5,...bodyPlans.map(plan=>plan.layout.fontSize/0.85)) : 10.5;
      for (const plan of plans) {
        if (!plan.heading) plan.layout=this.calculatePdfTextLayout(font,plan.text,plan.width,plan.height,false,true,Math.min(commonSize,plan.layout.fontSize),plan.layout.fontSize<this.options.compactMinFontSize);
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
      const small=plans.filter(plan=>plan.layout.fontSize<this.options.compactMinFontSize);
      if(small.length) {
        const message=`有 ${small.length} 段文字框较拥挤，已使用更小字号保留完整译文，请放大 PDF 查看。`;
        if(notify)notify(message,'warning');
        else if(typeof window!=='undefined' && typeof window.showNotification==='function')window.showNotification(message,'warning');
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

  expandHorizontalBox(item,items,size,plans=[]) {
    const range=this.options.bboxNormalizedRange;
    const box=item.bbox;
    const originalLeft=box[0]/range*size.width,originalRight=box[2]/range*size.width;
    const top=box[1]/range*size.height,bottom=box[3]/range*size.height;
    const grow=Math.min(60,(originalRight-originalLeft)*0.4);
    let left=Math.max(12,originalLeft-grow),right=Math.min(size.width-12,originalRight+grow);
    const obstacles=items.filter(other=>other && other!==item && other.page_idx===item.page_idx && Array.isArray(other.bbox) && other.bbox.length===4 && other.bbox.every(Number.isFinite)).map(other=>({left:other.bbox[0]/range*size.width,right:other.bbox[2]/range*size.width,top:other.bbox[1]/range*size.height,bottom:other.bbox[3]/range*size.height}));
    for(const plan of plans.filter(plan=>plan.pageIndex===item.page_idx)) obstacles.push({left:plan.x,right:plan.x+plan.width,top:size.height-plan.top,bottom:size.height-plan.top+plan.height});
    for(const obstacle of obstacles) {
      if(obstacle.bottom<=top || obstacle.top>=bottom) continue;
      if(obstacle.right<=originalLeft) left=Math.max(left,obstacle.right+3);
      else if(obstacle.left>=originalRight) right=Math.min(right,obstacle.left-3);
      else {left=originalLeft;right=originalRight;break;}
    }
    // 扩宽不能缩小原框，也不能跨越相邻栏或图表。
    left=Math.min(originalLeft,left); right=Math.max(originalRight,right);
    return {x:left,width:right-left};
  }

  calculatePdfTextLayout(font,text,boxWidth,boxHeight,isHeading=false,compact=false,preferredSize=null,forceFit=false) {
    const padding=Math.min(1,boxHeight*0.03,boxWidth*0.03);
    const availableWidth=boxWidth-padding*2,availableHeight=boxHeight-padding*2;
    let min=compact?this.options.compactMinFontSize:this.options.minFontSize;
    const max=Math.min(this.options.maxFontSize,preferredSize ?? (isHeading?18:10.5));
    if(forceFit) min=Math.min(min,max);
    if(availableWidth<=0 || availableHeight<=0 || min<=0 || max<min-0.01) return {fits:false};
    const candidate=(size,leading)=>{
      const lines=this.wrapTextForPdf(font,text,availableWidth,size);
      const lineHeight=size*leading;
      const usedHeight=size+(lines.length-1)*lineHeight;
      const fits=usedHeight<=availableHeight+1e-7 && lines.every(line=>font.widthOfTextAtSize(line,size)<=availableWidth+0.01);
      return {fontSize:size,lines,lineHeight,padding,fits};
    };
    const leadings=compact?(forceFit?[1.2,1.12,1.04,1.0]:[1.2,1.12,1.04]):[1.25];
    // 先保持字号压紧行距，最后才减小字号。
    for(const leading of leadings) {const trial=candidate(max,leading);if(trial.fits)return trial;}
    const leading=leadings[leadings.length-1];
    let best=candidate(min,leading);
    if(forceFit) {
      // 解除固定最低字号限制，直到整段真实排入框内；不丢字、不加附页。
      while(!best.fits && min>Number.MIN_VALUE*2) {min/=2;best=candidate(min,leading);}
    }
    if(!best.fits)return best;
    let low=min,high=Math.max(min,max);
    for(let step=0;step<32 && high-low>Math.max(1e-9,low*0.0005);step++) {
      const mid=(low+high)/2,trial=candidate(mid,leading);
      if(trial.fits){best=trial;low=mid;}else high=mid;
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
