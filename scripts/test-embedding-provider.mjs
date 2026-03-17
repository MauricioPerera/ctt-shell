import { OpenAiEmbeddingProvider } from '../dist/src/search/embedding.js';

const p = new OpenAiEmbeddingProvider({ baseUrl: 'http://localhost:9999', model: 'embeddinggemma', dimensions: 768 });

console.log('Provider:', p.name);
console.log('Available:', await p.isAvailable());

const start = Date.now();
const vecs = await p.embed([
  'create a blog post',
  'buscar productos en la tienda',
  'navegar a la pagina principal',
]);
const elapsed = Date.now() - start;

console.log('Vectors:', vecs.length);
console.log('Dims:', vecs[0].length);
console.log('L2 norm:', Math.sqrt(vecs[0].reduce((s, v) => s + v * v, 0)).toFixed(4));
console.log('Time:', elapsed + 'ms');

// Cosine similarity (vectors are L2-normalized, so dot product = cosine)
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
console.log('');
console.log('Cosine similarities:');
console.log('  [en:blog] vs [es:productos]:', dot(vecs[0], vecs[1]).toFixed(4));
console.log('  [es:productos] vs [es:navegar]:', dot(vecs[1], vecs[2]).toFixed(4));
console.log('  [en:blog] vs [es:navegar]:', dot(vecs[0], vecs[2]).toFixed(4));
