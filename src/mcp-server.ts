import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getTopItems, searchByName } from './tool.js';

// Creamos el servidor MCP
const server = new McpServer({
  name: 'rockin-github-worker',
  version: '1.0.0',
});

// Registramos la tool getTopItems para que un agente pueda usarla
server.registerTool(
  'getTopItems',
  {
    title: 'Get Top GitHub Repos',
    description: 'Consulta los repositorios de GitHub guardados, ordenados por estrellas. No vuelve a llamar a la API, solo lee lo persistido.',
    inputSchema: {
      limit: z.number().optional().describe('Número máximo de repos a devolver (por defecto 5)'),
    },
  },
  async ({ limit }) => {
    const resultado = getTopItems({ limit });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(resultado, null, 2),
        },
      ],
    };
  }
);

// Registramos la tool searchByName
server.registerTool(
  'searchByName',
  {
    title: 'Search GitHub Repos by Name',
    description: 'Busca repositorios de GitHub guardados por nombre (búsqueda parcial). No vuelve a llamar a la API, solo lee lo persistido.',
    inputSchema: {
      query: z.string().describe('Texto a buscar en el nombre del repositorio'),
    },
  },
  async ({ query }) => {
    const resultado = searchByName({ query });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(resultado, null, 2),
        },
      ],
    };
  }
);

// Conectamos el servidor por stdio (entrada/salida estándar)
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();