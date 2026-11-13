import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../lib/config.mjs';
import { createSearchAdapter, DEFAULT_SEARCH_MODEL } from '../lib/search.mjs';

test('search uses an explicit inexpensive model independently of the chat model', () => {
  const config = readConfig({ ARK_API_KEY: 'test-key', ARK_SEARCH_ENABLED: '1' });
  assert.equal(DEFAULT_SEARCH_MODEL, 'doubao-seed-2-0-mini-260428');
  assert.equal(config.search.metadata.endpoint, DEFAULT_SEARCH_MODEL);
  assert.equal(config.model.searchModel, DEFAULT_SEARCH_MODEL);
  assert.equal(config.model.name, 'deepseek-v4-1-flash-economy-261017');
  assert.equal(createSearchAdapter({ apiKey: 'test-key' }).metadata.endpoint, DEFAULT_SEARCH_MODEL);
  const overridden = readConfig({ ARK_API_KEY: 'test-key', ARK_SEARCH_ENABLED: '1', ARK_SEARCH_ENDPOINT: 'custom-search-endpoint' });
  assert.equal(overridden.search.metadata.endpoint, 'custom-search-endpoint');
  assert.equal(overridden.model.name, config.model.name);
  const disabled = readConfig({ ARK_API_KEY: 'test-key' });
  assert.equal(disabled.search, null);
  assert.equal(disabled.model.searchModel, null);
});
