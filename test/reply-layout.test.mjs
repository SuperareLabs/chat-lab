import test from 'node:test';
import assert from 'node:assert/strict';
import { replyMessages } from '../public/reply-layout.js';

test('one explicit message can contain paragraphs, lists, code and line breaks', () => {
  const text = '第一段。\n\n第二段。\n- 第一项\n- 第二项\n\n```js\nconst x = 1;\n\nconsole.log(x);\n```';
  assert.deepEqual(replyMessages(text, [text]), [text]);
});
test('explicit message count is independent of text length and paragraphs', () => {
  const parts = ['好啊', '那六点你也得醒', '第三条第一段。\n\n第三条第二段。'];
  assert.deepEqual(replyMessages(parts.join('\n\n'), parts), parts);
  assert.deepEqual(replyMessages('在\n怎么了？', ['在\n怎么了？']), ['在\n怎么了？']);
});
test('legacy replies are one message and user text is never guessed into messages', () => {
  const text = '好啊\r\n\r\n那六点你也得醒';
  assert.deepEqual(replyMessages(text), [text]);
  assert.deepEqual(replyMessages(text, ['']), [text]);
  assert.deepEqual(replyMessages(undefined), []);
});
