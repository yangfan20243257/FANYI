/** 原页内容按栏重排：统一正文大小，连续向下排，保留图表及独立公式的矢量内容。 */
class PDFExporter {
  constructor(options={}) {
    const script=typeof document!=='undefined' && Array.from(document.scripts).find(s=>/\/PDFExporter\.js(?:\?|$)/.test(s.src));
    const root=script?new URL('../../../',script.src).href:'/';
    this.options=Object.assign({fontUrl:root+'public/vendor/NotoSansSC-Regular.ttf',pdfLibUrl:root+'public/vendor/pdf-lib.min.js',fontkitUrl:root+'public/vendor/fontkit.umd.min.js',mathUrl:root+'public/vendor/mathjax-tex-svg.js',fontSize:10.5,margin:28,gutter:20},options);
    this.mathCache=new Map();this.warnings=[];
  }
  async exportStructuredTranslation(originalPdfBase64,content,notify=null,options={}) {
    try {
      this.warnings=[];
      if(!originalPdfBase64 || !Array.isArray(content))throw new Error('缺少原 PDF 或结构化译文，请重新处理文件。');
      if(notify)notify('正在按栏重新排版译文及公式…','info');
      await this.loadPdfLib();
      const source=await PDFLib.PDFDocument.load(this.base64ToUint8Array(originalPdfBase64));
      const doc=await PDFLib.PDFDocument.create();doc.registerFontkit(fontkit);
      const response=await fetch(this.options.fontUrl);
      if(!response.ok)throw new Error('中文字体加载失败，请检查 public/vendor/NotoSansSC-Regular.ttf');
      const font=await doc.embedFont(await response.arrayBuffer(),{subset:false});
      const unknown=[];
      const pageCount=source.getPageCount();
      const items=content.map((item,index)=>({...item,_index:index})).filter(item=>item && (this.itemText(item).trim() || ['image','table','formula','equation','isolate_formula'].includes(item.type)));
      for(const item of items)if(!Number.isInteger(item.page_idx) || item.page_idx<0 || item.page_idx>=pageCount)unknown.push(item);
      for(let pageIndex=0;pageIndex<pageCount;pageIndex++) {
        const original=source.getPage(pageIndex),size=original.getSize();
        const blocks=items.filter(item=>item.page_idx===pageIndex);
        if(!blocks.length) {
          // 不复制未翻译的整页，明确提示漏识别，避免将英文误当作译文输出。
          const page=doc.addPage([size.width,size.height]);
          page.drawText(`原第 ${pageIndex+1} 页没有可用的识别内容，请重新识别该页。`,{x:28,y:size.height-45,size:10.5,font});
          this.warnings.push(`原第 ${pageIndex+1} 页未识别到内容`);continue;
        }
        const layout=await this.layoutSourcePage(doc,original,font,blocks,size);
        // 同一原页可以适度加长；超长时按行/块分页，始终保持正常字号。
        this.drawFlow(doc,font,layout,size);
      }
      if(unknown.length) {
        const size={width:595.28,height:841.89};
        const layout=await this.layoutSourcePage(doc,null,font,unknown,size);
        this.drawFlow(doc,font,layout,size);this.warnings.push(`${unknown.length} 个片段页码缺失，已单独排版`);
      }
      const bytes=await doc.save();
      if(options.download!==false) {
        const blob=new Blob([bytes],{type:'application/pdf'}),name=options.filename||'translated.pdf';
        if(typeof saveAs==='function')saveAs(blob,name);
        else {const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      }
      if(this.warnings.length) {
        const message='PDF 已生成；'+Array.from(new Set(this.warnings)).slice(0,4).join('；');
        if(notify)notify(message,'warning');else if(typeof window!=='undefined' && window.showNotification)window.showNotification(message,'warning');
      } else if(notify)notify('译文 PDF 已生成。','success');
      return bytes;
    } catch(error) {if(notify)notify('PDF 导出失败：'+error.message,'error');if(options.download===false)throw error;console.error('[PDFExporter]',error);return null;}
  }
  itemText(item) {
    if(['image','table'].includes(item.type))return '';
    if(['formula','equation','isolate_formula'].includes(item.type))return item.latex||item.text||'';
    return typeof item.text==='string'?item.text:typeof item.content==='string'?item.content:'';
  }
  validBox(box) {return Array.isArray(box)&&box.length===4&&box.every(Number.isFinite)&&box[2]>box[0]&&box[3]>box[1];}
  async layoutSourcePage(doc,source,font,items,size) {
    const margin=this.options.margin,gutter=this.options.gutter,fullWidth=size.width-margin*2;
    const numbered=items.filter(item=>!item.renderInParent).map((item,index)=>({...item,_labels:item.id?items.filter(label=>label.renderInParent===item.id):[],bbox:this.validBox(item.bbox)?item.bbox:[0,990+index*.001,1000,991+index*.001]}));
    const left=numbered.filter(it=>it.bbox[2]<=535),right=numbered.filter(it=>it.bbox[0]>=465);
    const twoColumns=left.length>0&&right.length>0;
    const colWidth=twoColumns?(fullWidth-gutter)/2:fullWidth;
    const wide=twoColumns?numbered.filter(it=>it.bbox[0]<465&&it.bbox[2]>535):[];
    const order=(a,b)=>a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0]||a._index-b._index;
    wide.sort(order);
    const pending=numbered.filter(it=>!wide.includes(it)).sort(order);
    const runs=[];let cursor=margin;
    const append=async(list,x,width,start)=>{
      let y=start;
      for(const item of list) {
        const fragments=await this.makeBlock(doc,source,font,item,size,width);
        for(const fragment of fragments){runs.push({...fragment,x,y});y+=fragment.height;}
        y+=item.text_level>0?9:7;
      }
      return y;
    };
    const section=async(limit)=>{
      const batch=pending.filter(it=>(it.bbox[1]+it.bbox[3])/2<limit);
      for(const item of batch)pending.splice(pending.indexOf(item),1);
      if(!twoColumns){cursor=await append(batch,margin,fullWidth,cursor);return;}
      const a=batch.filter(it=>(it.bbox[0]+it.bbox[2])/2<500),b=batch.filter(it=>(it.bbox[0]+it.bbox[2])/2>=500);
      // 按原阅读顺序接续左右栏，再按实际行高平衡两栏，不保留原文短段落留下的大空白。
      const flow=[];
      for(const item of a.concat(b)) {
        const fragments=await this.makeBlock(doc,source,font,item,size,colWidth);
        flow.push(...fragments,{kind:'space',height:item.text_level>0?9:7});
      }
      const total=flow.reduce((sum,fragment)=>sum+fragment.height,0);
      let split=flow.length,best=Infinity,sum=0;
      for(let i=1;i<flow.length;i++) {sum+=flow[i-1].height;const diff=Math.abs(total/2-sum);if(diff<best){best=diff;split=i;}}
      let end=cursor;
      for(const [lane,list] of [flow.slice(0,split),flow.slice(split)].entries()) {
        let y=cursor;
        for(const fragment of list){if(fragment.kind!=='space')runs.push({...fragment,x:margin+lane*(colWidth+gutter),y});y+=fragment.height;}
        end=Math.max(end,y);
      }
      cursor=end;
    };
    for(const item of wide){await section((item.bbox[1]+item.bbox[3])/2);cursor=await append([item],margin,fullWidth,cursor);}
    await section(Infinity);
    return {runs,height:cursor+margin};
  }
  async makeBlock(doc,source,font,item,size,width) {
    const protectedBlock=['image','table','formula','equation','isolate_formula'].includes(item.type);
    const fragments=[];
    if(protectedBlock && source && this.validBox(item.bbox)) {
      const b=item.bbox.map(v=>Math.max(0,Math.min(1000,v)));
      const crop={left:b[0]/1000*size.width,right:b[2]/1000*size.width,bottom:size.height-b[3]/1000*size.height,top:size.height-b[1]/1000*size.height};
      if(crop.right>crop.left&&crop.top>crop.bottom) {
        try {
          const image=await doc.embedPage(source,crop),w=Math.min(width,image.width),height=image.height*w/image.width;
          const labels=[];
          for(const label of item._labels||[]) {
            if(!this.validBox(label.bbox)||!label.text)continue;
            const lx=Math.max(0,(label.bbox[0]-b[0])/(b[2]-b[0])*w-.5),ly=Math.max(0,(label.bbox[1]-b[1])/(b[3]-b[1])*height-.5);
            const lw=Math.min(w-lx,(label.bbox[2]-label.bbox[0])/(b[2]-b[0])*w+1),lh=Math.min(height-ly,(label.bbox[3]-label.bbox[1])/(b[3]-b[1])*height+1);
            if(lw<=0||lh<=0)continue;
            let fontSize=Math.min(this.options.fontSize,lh*.72),lines;
            do {lines=await this.layoutRichText(doc,font,label.text,lw,fontSize);if(lines.reduce((sum,line)=>sum+line.height,0)<=lh)break;fontSize*=.85;}while(fontSize>.3);
            labels.push({x:lx,y:ly,width:lw,height:lh,lines,fontSize});
            if(label.failed)this.warnings.push('个别图表标签翻译未成功，请重试');
          }
          fragments.push({kind:'crop',image,width:w,height:height+5,drawHeight:height,labels});
        }
        catch(error){this.warnings.push('个别图表读取失败');}
      }
    }
    if(protectedBlock && !fragments.length && !['image','table'].includes(item.type)) {
      const formula=await this.mathImage(doc,this.itemText(item).replace(/^\$+|\$+$/g,''),this.options.fontSize*1.2,true,width);
      if(formula)fragments.push({kind:'math',image:formula.image,width:formula.width,height:formula.height+6,drawHeight:formula.height});
    }
    let text=this.itemText(item);
    if(protectedBlock) {
      const caption=item.type==='image'?item.image_caption:item.type==='table'?item.table_caption:null;
      text=Array.isArray(caption)?caption.join('\n'):typeof caption==='string'?caption:'';
      // MinerU 的 caption 常作为独立 text 块提供，这里只处理明确提供的译文。
    }
    if(text.trim()) {
      const heading=item.text_level>0;
      const fontSize=heading?14:protectedBlock?9.5:this.options.fontSize;
      const lines=await this.layoutRichText(doc,font,text,width,fontSize);
      if(item.failed)this.warnings.push('存在翻译失败段落，已保留现有文字，请重试翻译');
      for(const line of lines)fragments.push({kind:'line',atoms:line.atoms,width,height:line.height,fontSize,ascent:line.ascent});
    }
    return fragments;
  }
  async layoutRichText(doc,font,text,width,fontSize) {
    text=text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ');
    const parts=this.splitMath(text),atoms=[];
    for(const part of parts) {
      if(part.math) {
        const result=await this.mathImage(doc,part.text,fontSize,false,width);
        if(result){atoms.push({kind:'math',...result});continue;}
        part.text=this.plainMath(part.text);
      }
      for(const char of Array.from(this.plainMath(part.text))) {
        if(char==='\n'){atoms.push({kind:'newline'});continue;}
        atoms.push({kind:'text',text:char,width:font.widthOfTextAtSize(char,fontSize),height:fontSize});
      }
    }
    const lines=[];let line=[],used=0;
    const flush=()=>{const ascent=Math.max(fontSize,...line.map(atom=>atom.kind==='math'?atom.height*0.85:fontSize));const descent=Math.max(fontSize*.25,...line.filter(atom=>atom.kind==='math').map(atom=>atom.height*.15));lines.push({atoms:line,height:Math.max(fontSize*1.42,ascent+descent+2),ascent});line=[];used=0;};
    for(const atom of atoms) {
      if(atom.kind==='newline'){flush();continue;}
      if(line.length&&used+atom.width>width)flush();
      if(!line.length&&atom.kind==='text'&&atom.text===' ')continue;
      line.push(atom);used+=atom.width;
    }
    if(line.length)flush();
    return lines;
  }
  splitMath(text) {
    const parts=[],pattern=/\$\$([\s\S]*?)\$\$|\$((?:\\.|[^$\n])+)\$|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
    let pos=0,match;
    while((match=pattern.exec(text))) {
      if(match.index>pos)parts.push({text:text.slice(pos,match.index)});
      parts.push({math:true,text:match[1]??match[2]??match[3]??match[4]});pos=pattern.lastIndex;
    }
    if(pos<text.length)parts.push({text:text.slice(pos)});
    return parts;
  }
  plainMath(text) {
    // 没有定界符的简单 TeX 记号转为正常 Unicode，避免输出反斜杠源码。
    const symbols={alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',theta:'θ',lambda:'λ',mu:'μ',sigma:'σ',tau:'τ',phi:'φ',omega:'ω',Sigma:'Σ',Delta:'Δ',Omega:'Ω',in:'∈',notin:'∉',times:'×',cdot:'·',leq:'≤',geq:'≥',neq:'≠',infty:'∞',sum:'∑',prod:'∏',partial:'∂',nabla:'∇',pm:'±',rightarrow:'→',leftarrow:'←',ell:'ℓ',mathbb:'',left:'',right:'',quad:' ',qquad:' '};
    text=text.replace(/\\(?:text|mathrm|mathbf|mathit|mathcal|operatorname|boldsymbol)\s*\{([^{}]*)\}/g,'$1');
    text=text.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,'($1)/($2)').replace(/\\sqrt\s*\{([^{}]*)\}/g,'√($1)');
    text=text.replace(/\\(?:tilde|hat|bar|vec)\s*\{([^{}]*)\}/g,(all,s)=>s+({'tilde':'̃'}[all.match(/\\([a-z]+)/)[1]]||'̂'));
    text=text.replace(/\\([a-zA-Z]+)/g,(all,key)=>Object.hasOwn(symbols,key)?symbols[key]:key);
    const sub={'0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','i':'ᵢ','j':'ⱼ','n':'ₙ','k':'ₖ','x':'ₓ'},sup={'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','n':'ⁿ','i':'ⁱ'};
    text=text.replace(/([_^])(?:\{([^{}]*)\}|([A-Za-z0-9+\-]))/g,(all,type,a,b)=>{const value=a??b,map=type==='_'?sub:sup;return Array.from(value).every(ch=>map[ch])?Array.from(value).map(ch=>map[ch]).join(''):(type==='_'?'₍':'⁽')+value+(type==='_'?'₎':'⁾');});
    return text.replace(/\\[,;! ]/g,' ').replace(/\\([{}%&#_$])/g,'$1').replace(/[{}]/g,'');
  }
  async mathImage(doc,tex,fontSize,display,maxWidth) {
    try {
      let rendered=this.mathCache.get(tex);
      if(!rendered) {
        await this.loadMathJax();
        const node=await MathJax.tex2svgPromise(tex,{display});
        const svg=node.querySelector('svg');if(!svg || svg.querySelector('[data-mjx-error]'))throw new Error('公式语法错误');
        const box=svg.getAttribute('viewBox').split(/\s+/).map(Number);
        svg.removeAttribute('xmlns');svg.setAttributeNS('http://www.w3.org/2000/xmlns/','xmlns','http://www.w3.org/2000/svg');svg.setAttribute('width',String(Math.ceil(box[2]*.05)));svg.setAttribute('height',String(Math.ceil(box[3]*.05)));svg.style.color='black';
        for(const g of svg.querySelectorAll('g')){g.setAttribute('fill','black');g.setAttribute('stroke','black');}
        rendered={bytes:await this.rasterizeSvg(svg),emWidth:box[2]/1000,emHeight:box[3]/1000};this.mathCache.set(tex,rendered);
      }
      const scale=Math.min(1,maxWidth/(rendered.emWidth*fontSize));
      return {image:await doc.embedPng(rendered.bytes),width:rendered.emWidth*fontSize*scale,height:rendered.emHeight*fontSize*scale};
    } catch(error) {if(this.options.debug)console.warn('[PDF math]',error);this.warnings.push('个别公式渲染失败，已用可读符号替代');return null;}
  }
  async rasterizeSvg(svg) {
    const blob=new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'}),url=URL.createObjectURL(blob);
    try {
      const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url;});
      const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
      canvas.getContext('2d').drawImage(img,0,0);
      const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!png)throw new Error('公式图像生成失败');
      return await png.arrayBuffer();
    } finally {URL.revokeObjectURL(url);}
  }
  drawFlow(doc,font,layout,size) {
    const margin=this.options.margin;
    // 保持原页宽度，正文需要时加长页面；PDF 最大常规尺寸内不缩小正文。
    const pageHeight=Math.min(Math.max(size.height,layout.height),14400);
    const capacity=pageHeight-margin*2;
    const pages=new Map();
    const pageAt=index=>{if(!pages.has(index))pages.set(index,doc.addPage([size.width,pageHeight]));return pages.get(index);};
    const offsets=new Map();
    for(const run of layout.runs) {
      const lane=run.x;
      let offset=offsets.get(lane)||0,y=run.y-margin+offset;
      let index=Math.floor(y/capacity),within=y-index*capacity;
      const actualHeight=run.height;
      if(within+actualHeight>capacity && actualHeight<=capacity){offset+=capacity-within;offsets.set(lane,offset);index++;within=0;}
      const page=pageAt(index),top=pageHeight-margin-within;
      if(run.kind==='line') {
        let x=run.x;const baseline=top-run.ascent;
        // 合并连续文字，保留 PDF 文本的复制/搜索顺序。
        let segment='',segmentX=x;
        const flush=()=>{if(segment)page.drawText(segment,{x:segmentX,y:baseline,font,size:run.fontSize,color:PDFLib.rgb(0,0,0)});segment='';};
        for(const atom of run.atoms) {
          if(atom.kind==='math'){flush();page.drawImage(atom.image,{x,y:baseline-atom.height*.15,width:atom.width,height:atom.height});x+=atom.width;segmentX=x;}
          else {if(!segment)segmentX=x;segment+=atom.text;x+=atom.width;}
        }
        flush();
      } else {
        const factor=Math.min(1,capacity/run.drawHeight),h=run.drawHeight*factor,w=run.width*factor;
        if(run.kind==='crop') {
          page.drawPage(run.image,{x:run.x,y:top-h,width:w,height:h});
          for(const label of run.labels||[]) {
            const x=run.x+label.x*factor,labelTop=top-label.y*factor;
            page.drawRectangle({x,y:labelTop-label.height*factor,width:label.width*factor,height:label.height*factor,color:PDFLib.rgb(1,1,1)});
            let lineTop=labelTop;
            for(const line of label.lines) {
              let charX=x;const baseline=lineTop-line.ascent*factor;
              for(const atom of line.atoms) {
                if(atom.kind==='math')page.drawImage(atom.image,{x:charX,y:baseline-atom.height*.15*factor,width:atom.width*factor,height:atom.height*factor});
                else page.drawText(atom.text,{x:charX,y:baseline,font,size:label.fontSize*factor,color:PDFLib.rgb(0,0,0)});
                charX+=atom.width*factor;
              }
              lineTop-=line.height*factor;
            }
          }
        } else page.drawImage(run.image,{x:run.x,y:top-h,width:w,height:h});
      }
    }
    if(!pages.size)pageAt(0);
  }
  async loadMathJax() {
    if(typeof MathJax!=='undefined'&&typeof MathJax.tex2svgPromise==='function'){if(MathJax.startup?.promise)await MathJax.startup.promise;return;}
    if(!PDFExporter.mathLoad)PDFExporter.mathLoad=(async()=>{
      window.MathJax={startup:{typeset:false},svg:{fontCache:'none'},options:{enableMenu:false},loader:{load:[]}};
      await this.loadScript(this.options.mathUrl,'MathJax');await MathJax.startup.promise;
    })().catch(error=>{PDFExporter.mathLoad=null;throw error;});
    return PDFExporter.mathLoad;
  }
  async loadPdfLib() {if(typeof PDFLib==='undefined')await this.loadScript(this.options.pdfLibUrl,'PDFLib');if(typeof fontkit==='undefined')await this.loadScript(this.options.fontkitUrl,'fontkit');}
  loadScript(url,name) {
    PDFExporter.scriptLoads=PDFExporter.scriptLoads||new Map();
    if(!PDFExporter.scriptLoads.has(url))PDFExporter.scriptLoads.set(url,new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.onload=()=>window[name]?resolve():reject(new Error(name+' 加载异常'));script.onerror=()=>reject(new Error(name+' 加载失败'));document.head.appendChild(script);}).catch(error=>{PDFExporter.scriptLoads.delete(url);throw error;}));
    return PDFExporter.scriptLoads.get(url);
  }
  base64ToUint8Array(base64) {return Uint8Array.from(atob(base64.replace(/^data:application\/pdf;base64,/,'')),ch=>ch.charCodeAt(0));}
}
if(typeof window!=='undefined')window.PDFExporter=PDFExporter;
if(typeof module!=='undefined'&&module.exports)module.exports=PDFExporter;
