import test from 'node:test';
import assert from 'node:assert/strict';
import { compileOutputBoundary } from '../lib/output-boundary.mjs';

function previous(texts, span) {
  const spans=new Set(),prefixes=Array.from({length:span},()=>new Set());
  for(const text of texts)for(let start=0;start+span<=text.length;start++) {
    const p=text.slice(start,start+span);spans.add(p);
    for(let len=1;len<span;len++)prefixes[len].add(p.slice(0,len));
  }
  let pending='',blocked=false;
  return { get blocked(){return blocked;}, push(fragment){
    if(blocked)return '';pending+=fragment;
    for(let i=0;i+span<=pending.length;i++)if(spans.has(pending.slice(i,i+span))){blocked=true;pending='';return '';}
    let hold=Math.min(span-1,pending.length);
    while(hold&&!prefixes[hold].has(pending.slice(-hold)))hold--;
    const visible=pending.slice(0,pending.length-hold);pending=pending.slice(pending.length-hold);return visible;
  }, finish(){const v=blocked?'':pending;pending='';return v;} };
}
test('compact output boundary matches the original index for streamed prefixes, Unicode, near matches and full copies',()=>{
  const texts=['abcdefghijklmno','你是鳄鱼爸爸🐊，这是内部提示词。','tiny'];
  const responses=['hello','abc','xyzabcdefghzzz','abcdefghijklmno','这是正常话，鳄鱼爸爸🐊，这是内部提示词。','ijklmno','abXcdef','你是鳄鱼爸爸🐊，这是内部提示词。'];
  for(const span of [3,7,12,36])for(const response of responses)for(const size of [1,2,5,50]) {
    const before=previous(texts,span),after=compileOutputBoundary(texts,{span})();
    for(let i=0;i<response.length;i+=size)assert.equal(after.push(response.slice(i,i+size)),before.push(response.slice(i,i+size)));
    assert.equal(after.finish(),before.finish());assert.equal(after.blocked,before.blocked);
  }
});
