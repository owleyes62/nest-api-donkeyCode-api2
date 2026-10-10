/**
 * Testa o upload de foto contra a API local, de ponta a ponta.
 *
 *   node scripts/testar-upload-foto.cjs                      # usa um PNG de teste
 *   node scripts/testar-upload-foto.cjs "C:\\fotos\\planta.jpg"
 *   node scripts/testar-upload-foto.cjs foto.jpg --manter    # não apaga no fim
 *
 * Precisa apenas da API rodando (`npm run dev`).
 *
 * Por que existe: o login está protegido por reCAPTCHA, então não dá para
 * autenticar pelo Swagger sem um token do Google. Aqui o JWT é assinado
 * localmente com o JWT_SECRET do .env — o mesmo que a API usa para validar —
 * o que dispensa passar pelo /users/login.
 *
 * Localmente o arquivo vai para public/uploads/ e a API devolve
 * `/uploads/<nome>`; o Vercel Blob só entra em cena quando VERCEL está
 * definido (ou seja, no deploy).
 */
require('dotenv/config');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const BASE = process.env.API_URL ?? 'http://localhost:3000/api';
const EMAIL = process.env.DEMO_EMAIL ?? 'demo@donkeycode.com';
const MANTER = process.argv.includes('--manter');
const CAMINHO = process.argv.slice(2).find((a) => !a.startsWith('--'));

// PNG 1x1 válido, para quando nenhum arquivo é informado.
const PNG_TESTE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function lerImagem() {
  if (!CAMINHO) {
    return { bytes: PNG_TESTE, nome: 'teste.png', mime: 'image/png' };
  }

  if (!fs.existsSync(CAMINHO)) {
    throw new Error(`Arquivo não encontrado: ${CAMINHO}`);
  }

  const ext = path.extname(CAMINHO).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    throw new Error(`Extensão ${ext} não aceita. Use .png, .jpg, .jpeg ou .webp`);
  }

  const bytes = fs.readFileSync(CAMINHO);
  const mb = bytes.length / 1024 / 1024;
  if (mb > 5) {
    console.log(`AVISO: o arquivo tem ${mb.toFixed(1)} MB e o limite da API é 5 MB.`);
    console.log('       A API deve responder 413 IMAGEM_GRANDE — o que também é um teste válido.\n');
  }

  return { bytes, nome: path.basename(CAMINHO), mime };
}

async function main() {
  // A API não precisa estar acessível para isso: assina com o mesmo segredo.
  const segredo = process.env.JWT_SECRET;
  if (!segredo) throw new Error('JWT_SECRET ausente no .env');

  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (!user) throw new Error(`Usuário ${EMAIL} não encontrado. Rode: npx tsx prisma/seed-demo.ts`);

  const token = jwt.sign({ sub: user.id }, segredo, { expiresIn: '10m' });
  const auth = { Authorization: `Bearer ${token}` };

  // Qualquer lista a que o usuário tenha acesso serve para pendurar o formulário.
  const lista = await prisma.listaDeFormularios.findFirst({
    where: { canteiro: { users: { some: { user_id: user.id } } } },
    orderBy: { createdAt: 'desc' },
  });
  if (!lista) throw new Error(`${EMAIL} não está vinculado a nenhum canteiro com lista.`);

  const imagem = lerImagem();
  console.log(`usuário : ${user.name} <${user.email}>`);
  console.log(`lista   : ${lista.id}`);
  console.log(`imagem  : ${imagem.nome} (${imagem.mime}, ${(imagem.bytes.length / 1024).toFixed(1)} KB)\n`);

  // 1) formulário que vai receber a foto
  const criar = await fetch(`${BASE}/formularios`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ list_id: lista.id, user_id: user.id, type: 'SEMANAL', week: 1 }),
  });
  const formulario = await criar.json();
  if (criar.status !== 201) {
    throw new Error(`Falha ao criar o formulário: ${criar.status} ${JSON.stringify(formulario)}`);
  }
  console.log(`1. formulário criado: ${formulario.id}`);

  // 2) o upload em si
  const fd = new FormData();
  fd.append('photo', new Blob([imagem.bytes], { type: imagem.mime }), imagem.nome);
  fd.append('form_id', formulario.id);

  const envio = await fetch(`${BASE}/photos/upload`, { method: 'POST', headers: auth, body: fd });
  const resposta = await envio.json().catch(() => ({}));
  console.log(`2. POST /photos/upload -> ${envio.status}`);
  console.log(`   ${JSON.stringify(resposta)}`);

  if (envio.status !== 201) {
    console.log('\n>>> upload RECUSADO (veja a mensagem acima).');
    if (!MANTER) await limpar(formulario.id);
    return;
  }

  // 3) o arquivo existe mesmo no disco?
  const nomeNoDisco = String(resposta.url).replace('/uploads/', '');
  const noDisco = path.resolve('public/uploads', nomeNoDisco);
  const existe = fs.existsSync(noDisco);
  console.log(`\n3. arquivo em disco: ${existe ? 'OK' : 'NÃO ENCONTRADO'}`);
  if (existe) {
    console.log(`   ${noDisco} (${fs.statSync(noDisco).size} bytes)`);
  }

  // 4) a API devolve a foto na listagem do formulário?
  const listar = await fetch(`${BASE}/formularios/${formulario.id}/photos`, { headers: auth });
  const fotos = await listar.json();
  console.log(`\n4. GET /formularios/${formulario.id}/photos -> ${listar.status}`);
  console.log(`   ${Array.isArray(fotos) ? fotos.length : '?'} foto(s): ${JSON.stringify(fotos).slice(0, 160)}`);

  // 5) e dá para baixar pela URL devolvida?
  const estatico = `${BASE.replace(/\/api$/, '')}${resposta.url}`;
  const baixar = await fetch(estatico);
  console.log(`\n5. GET ${estatico} -> ${baixar.status} (${baixar.headers.get('content-type')})`);

  console.log(`\n>>> upload funcionando. URL salva no banco: ${resposta.url}`);

  if (MANTER) {
    console.log(`\n(--manter: formulário ${formulario.id} e a foto ficaram no banco)`);
  } else {
    await limpar(formulario.id, noDisco);
  }
}

async function limpar(formularioId, arquivo) {
  await prisma.photo.deleteMany({ where: { form_id: formularioId } });
  await prisma.checklist.deleteMany({ where: { form_id: formularioId } });
  await prisma.measurement.deleteMany({ where: { form_id: formularioId } });
  await prisma.formulario.delete({ where: { id: formularioId } }).catch(() => undefined);
  if (arquivo && fs.existsSync(arquivo)) fs.unlinkSync(arquivo);
  console.log('\n(limpeza feita: formulário, foto e arquivo removidos — use --manter para conservar)');
}

main()
  .catch((e) => {
    console.error(`\nERRO: ${e.message}`);
    if (/fetch failed|ECONNREFUSED/.test(e.message)) {
      console.error('A API não respondeu. Suba com `npm run dev` em outro terminal.');
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
