// A bounded exact-copy backstop, not a semantic guarantee against prompt extraction.
// Ordinary text is emitted immediately unless it is a prefix of protected text.
export function compileOutputBoundary(privateTexts,{span=36}={}) {
  const protectedSpans=new Set(),prefixes=Array.from({length:span},()=>new Set());
  for(const text of privateTexts)for(let start=0;start+span<=text.length;start++) {
    const pattern=text.slice(start,start+span);protectedSpans.add(pattern);
    for(let length=1;length<span;length++)prefixes[length].add(pattern.slice(0,length));
  }
  return ()=>{
    let pending='',blocked=false;
    return {
      get blocked(){return blocked;},
      push(fragment){
        if(blocked)return '';pending+=fragment;
        for(let i=0;i+span<=pending.length;i++)if(protectedSpans.has(pending.slice(i,i+span))){blocked=true;pending='';return '';}
        let hold=Math.min(span-1,pending.length);
        while(hold&&!prefixes[hold].has(pending.slice(-hold)))hold--;
        const visible=pending.slice(0,pending.length-hold);pending=pending.slice(pending.length-hold);return visible;
      },
      finish(){const visible=blocked?'':pending;pending='';return visible;},
    };
  };
}
