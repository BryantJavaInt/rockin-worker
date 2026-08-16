import 'dotenv/config';
import { upsertRepo, Repo } from './store.js';

type SyncSummary = {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  apiCalls: number;
  durationMs: number;
  capped: boolean;
};

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MAX_PAGES = 5;

function esperar(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchConReintentos(url: string, headers: any, maxIntentos = 3): Promise<Response> {
  for (let intento = 1; intento <= maxIntentos; intento++) {
    const response = await fetch(url, { headers });

    if (response.ok) {
      return response;
    }

    if (response.status === 401 || response.status === 404) {
      return response;
    }

    if (response.status === 429 || response.status >= 500) {
      if (intento < maxIntentos) {
        const jitter = Math.random() * 500;
        const esperaMs = (1000 * intento) + jitter;
        console.log(`Error ${response.status}, reintentando en ${esperaMs.toFixed(0)}ms (intento ${intento}/${maxIntentos})`);
        await esperar(esperaMs);
        continue;
      }
    }

    return response;
  }

  throw new Error('No se pudo completar la petición tras los reintentos');
}

async function sync(): Promise<SyncSummary> {
  const startTime = Date.now();

  if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN no está definido en el .env');
  }

  const summary: SyncSummary = {
    fetched: 0, inserted: 0, updated: 0, skipped: 0,
    errors: 0, apiCalls: 0, durationMs: 0, capped: false,
  };

  let page = 1;
  let hasMore = true;

  while (hasMore && page <= MAX_PAGES) {
    const response = await fetchConReintentos(
      `https://api.github.com/user/repos?per_page=30&page=${page}`,
      {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      }
    );

    summary.apiCalls++;

    if (!response.ok) {
      console.log('Error en la llamada (no recuperable o reintentos agotados):', response.status);
      summary.errors++;
      break;
    }

    const repos = await response.json();

    if (repos.length === 0) {
      hasMore = false;
    } else {
      for (const repo of repos) {
        summary.fetched++;

        const result = upsertRepo({
          id: repo.id,
          name: repo.name,
          stars: repo.stargazers_count,
          syncedAt: new Date().toISOString(),
        });

        if (result === 'inserted') summary.inserted++;
        if (result === 'updated') summary.updated++;
      }
      page++;
    }
  }

  if (page > MAX_PAGES) {
    summary.capped = true;
  }

  summary.durationMs = Date.now() - startTime;
  return summary;
}

sync().then(result => {
  console.log('Resumen del sync:', result);
});