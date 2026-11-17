// Preserve the existing Shen-only command and its optional review copy path.
import { syncLocalPersonas } from './sync-local-personas.mjs';
console.log(JSON.stringify(syncLocalPersonas({ ids: ['shen-zhiheng'],
  reviewCopies: process.argv[2] ? { 'shen-zhiheng': process.argv[2] } : {} })));
