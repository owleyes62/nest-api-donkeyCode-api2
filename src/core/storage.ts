import { BadRequestException, Logger } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';

import { HttpError } from './httpError';
import { UPLOAD_DIR } from './upload.config';

const logger = new Logger('Storage');

const NA_VERCEL = !!process.env.VERCEL;

/**
 * Lê o token saneado.
 *
 * Colar o valor no painel da Vercel com aspas em volta ou um 
 no fim é o
 * erro mais comum, e o @vercel/blob não avisa: ele só devolve "Access denied".
 * Por isso o token é limpo aqui e passado explicitamente para o put/del, em
 * vez de deixar a lib ler a variável crua.
 */
function lerTokenDoBlob(): string | undefined {
  const bruto = process.env.BLOB_READ_WRITE_TOKEN;
  if (!bruto) return undefined;

  const limpo = bruto.trim().replace(/^["']+|["']+$/g, '').trim();
  return limpo || undefined;
}

/** Descreve o token sem revelá-lo, para dar para comparar ambientes no log. */
function descreverToken(token?: string): string {
  if (!token) return 'ausente';

  const store = /^vercel_blob_rw_([^_]+)_/.exec(token)?.[1];
  const formatoOk = token.startsWith('vercel_blob_rw_');

  return (
    `${token.length} chars, store "${store ?? '???'}", ` +
    `prefixo ${token.slice(0, 15)}…${formatoOk ? '' : ' (FORMATO INESPERADO — deveria começar com vercel_blob_rw_)'}`
  );
}

const TOKEN_BLOB = lerTokenDoBlob();
const TEM_TOKEN_BLOB = !!TOKEN_BLOB;

// Aviso na subida, não na primeira foto: assim o problema aparece no log do
// deploy em vez de um aluno descobrir no meio do preenchimento do formulário.
// Vincular o Blob store ao projeto na Vercel injeta a variável — mas só vale
// em build novo, então é preciso refazer o deploy depois de vincular.
if (NA_VERCEL && !TEM_TOKEN_BLOB) {
  logger.error(
    'BLOB_READ_WRITE_TOKEN não configurado neste ambiente da Vercel: ' +
      'TODO upload de imagem vai falhar. Vincule o Blob store ao projeto ' +
      '(Storage → Connect Project) ou defina a variável em Settings → ' +
      'Environment Variables, e REFAÇA O DEPLOY.',
  );
} else if (NA_VERCEL) {
  // Registra a forma do token na subida: comparar este log com o do ambiente
  // local mostra na hora se o valor foi colado errado ou aponta outro store.
  logger.log(`Vercel Blob configurado — token: ${descreverToken(TOKEN_BLOB)}`);
}

/**
 * Traduz a falha do @vercel/blob em algo acionável.
 *
 * Sem isso, "Access denied, please provide a valid token for this resource"
 * chegava ao cliente como 500 "Erro interno do servidor" — e só era possível
 * descobrir a causa lendo o stack trace no log da Vercel.
 */
function traduzirErroDoBlob(e: any): HttpError {
  const nome = String(e?.name ?? '');
  const msg = String(e?.message ?? '');

  // Token ausente, inválido, expirado ou de outro store: configuração nossa.
  if (
    nome === 'BlobAccessError' ||
    nome === 'BlobClientTokenExpiredError' ||
    nome === 'BlobStoreNotFoundError' ||
    /access denied|valid token|not found/i.test(msg)
  ) {
    logger.error(
      `Vercel Blob recusou a credencial (${nome || 'sem nome'}): ${msg}. ` +
        `Token em uso: ${descreverToken(TOKEN_BLOB)}. ` +
        'Compare o store com o do painel; se divergir, a variável aponta para outro Blob store.',
    );
    return new HttpError(
      'Armazenamento de imagens não está configurado no servidor',
      503,
      { codigo: 'BLOB_MAL_CONFIGURADO' },
    );
  }

  if (nome === 'BlobStoreSuspendedError') {
    logger.error('Vercel Blob store suspenso.');
    return new HttpError('Armazenamento de imagens suspenso', 503, {
      codigo: 'BLOB_SUSPENSO',
    });
  }

  if (nome === 'BlobFileTooLargeError') {
    return new HttpError('Imagem grande demais para o armazenamento', 413, {
      codigo: 'IMAGEM_GRANDE',
    });
  }

  if (nome === 'BlobContentTypeNotAllowedError') {
    return new HttpError('Tipo de imagem não aceito pelo armazenamento', 400, {
      codigo: 'IMAGEM_TIPO_INVALIDO',
    });
  }

  logger.error(`Falha ao enviar a imagem para o Vercel Blob: ${nome} ${msg}`);
  return new HttpError('Não foi possível salvar a imagem. Tente novamente.', 502, {
    codigo: 'BLOB_INDISPONIVEL',
  });
}

// Transforma o arquivo recebido pelo multer numa URL persistida.
// Em prod (Vercel) sobe pro Blob; em dev o arquivo já está em public/uploads.
export async function persistUploadedFile(
  file: Express.Multer.File,
  prefix: string,
): Promise<string> {
  if (!file) {
    throw new BadRequestException('Arquivo é obrigatório');
  }

  if (!NA_VERCEL) {
    return `/uploads/${file.filename}`;
  }

  // Erro de configuração: responde antes de gastar a chamada ao Blob.
  if (!TEM_TOKEN_BLOB) {
    throw new HttpError('Armazenamento de imagens não está configurado no servidor', 503, {
      codigo: 'BLOB_MAL_CONFIGURADO',
    });
  }

  try {
    const { put } = await import('@vercel/blob');
    const blob = await put(`${prefix}/${Date.now()}-${file.originalname}`, file.buffer, {
      access: 'public',
      contentType: file.mimetype,
      // Explícito, com o valor já saneado — não deixa a lib ler a env crua.
      token: TOKEN_BLOB,
    });

    return blob.url;
  } catch (err: any) {
    if (err instanceof HttpError) throw err;
    throw traduzirErroDoBlob(err);
  }
}

// Best-effort cleanup do arquivo anterior (Blob ou disco).
// Nunca derruba o request se falhar.
export async function removeStoredFile(url: string | null | undefined): Promise<void> {
  if (!url) return;

  try {
    if (url.startsWith('http')) {
      const { del } = await import('@vercel/blob');
      await del(url, { token: TOKEN_BLOB });
      return;
    }

    if (url.startsWith('/uploads/')) {
      const filePath = path.resolve(UPLOAD_DIR, url.replace('/uploads/', ''));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  } catch (err) {
    logger.warn(`Falha ao remover arquivo anterior (${url}): ${(err as Error).message}`);
  }
}
