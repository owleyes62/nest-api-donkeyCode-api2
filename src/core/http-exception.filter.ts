import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { HttpError } from './httpError';
import { traduzirErroDoPrisma } from './prisma-error';

interface Resolvido {
  status: number;
  message: string;
  codigo?: string;
  campos?: Record<string, string>;
}

// Campos que nunca devem aparecer no log.
const SIGILOSOS = ['password', 'senha', 'token', 'refreshToken', 'accessToken', 'authorization'];

function corpoParaLog(body: unknown): string {
  if (!body || typeof body !== 'object') return '-';

  const limpo: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    limpo[k] = SIGILOSOS.includes(k) ? '***' : v;
  }

  const texto = JSON.stringify(limpo);
  return texto.length > 500 ? texto.slice(0, 500) + '…' : texto;
}

// Sem este filtro, o HttpError lançado pelos services (que não estende
// HttpException) virava 500 no Nest — mesmo quando era 400/403/404.
// A resposta mantém { error: mensagem } e acrescenta `codigo` e `campos`
// quando existem, para o front saber o que destacar.
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, message, codigo, campos } = this.resolve(exception);

    // Todo erro deixa rastro, não só os 500. Um 400 sem log é um 400 que
    // ninguém consegue depurar — e é justamente o mais comum.
    const linha =
      `${request.method} ${request.url} -> ${status} ${codigo ?? ''} | ${message} | body: ` +
      corpoParaLog(request.body);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(linha, (exception as any)?.stack);
    } else {
      this.logger.warn(linha);
    }

    // Em rotas de stream (ex.: export-pdf) o header já pode ter sido enviado.
    if (response.headersSent) {
      return response.end();
    }

    return response.status(status).json({
      error: message,
      ...(codigo ? { codigo } : {}),
      ...(campos ? { campos } : {}),
    });
  }

  /** Erros levantados pelo body parser / multer, fora do nosso código. */
  private resolveErroDeRequisicao(e: any): Resolvido | null {
    const tipo = String(e?.type ?? '');
    const nome = String(e?.name ?? '');

    if (tipo === 'entity.too.large' || nome === 'PayloadTooLargeError') {
      const limite = e?.limit ? `${Math.round(e.limit / 1024)} KB` : 'o limite';
      return {
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        message:
          `Corpo da requisição maior que ${limite}. ` +
          'Para enviar imagem, use multipart em POST /photos/upload em vez de base64 no JSON.',
        codigo: 'CORPO_GRANDE',
      };
    }

    return null;
  }

  /** Mensagens que o Nest já traduziu do multer/parser, em inglês e sem código. */
  private traduzirMensagemDoNest(texto: string, status: number): Resolvido | null {
    if (/^File too large$/i.test(texto)) {
      return {
        status,
        message: 'Imagem maior que o limite de 5 MB',
        codigo: 'IMAGEM_GRANDE',
      };
    }

    if (/^Unexpected field$/i.test(texto)) {
      return {
        status,
        message: 'Campo de arquivo inesperado. Envie um único arquivo no campo "photo".',
        codigo: 'CAMPO_ARQUIVO_INVALIDO',
      };
    }

    if (/^Too many (files|parts)$/i.test(texto)) {
      return { status, message: 'Envie um arquivo por vez', codigo: 'CAMPO_ARQUIVO_INVALIDO' };
    }

    if (/in JSON at position|Unexpected token.*JSON|Expected property name/i.test(texto)) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: `JSON inválido no corpo da requisição (${texto})`,
        codigo: 'JSON_INVALIDO',
      };
    }

    return null;
  }

  private resolve(exception: unknown): Resolvido {
    if (exception instanceof HttpError) {
      return {
        status: exception.status,
        message: exception.message,
        codigo: exception.codigo,
        campos: exception.campos,
      };
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const bruto = typeof body === 'string' ? body : ((body as any)?.message ?? exception.message);

      // O ValidationPipe devolve um array de mensagens, uma por campo.
      const lista = Array.isArray(bruto) ? bruto.map(String) : null;
      const texto = lista ? lista.join('; ') : String(bruto);

      // O Nest converte os erros do multer e do parser de JSON em HttpException
      // antes deste filtro, com a mensagem crua em inglês e sem código.
      const conhecido = this.traduzirMensagemDoNest(texto, exception.getStatus());
      if (conhecido) return conhecido;

      return {
        status: exception.getStatus(),
        message: texto,
        ...(lista ? { codigo: 'VALIDACAO' } : {}),
      };
    }

    // Erro do Prisma: quase sempre é problema do cliente (id inexistente,
    // campo faltando) e merece 400/404/409 com nome, não um 500 genérico.
    const doPrisma = traduzirErroDoPrisma(exception);
    if (doPrisma) {
      return {
        status: doPrisma.status,
        message: doPrisma.message,
        codigo: doPrisma.codigo,
        campos: doPrisma.campos,
      };
    }

    // Vem do body parser, antes de qualquer código nosso rodar. Acontece
    // quando o front manda imagem em base64 dentro do JSON.
    const daRequisicao = this.resolveErroDeRequisicao(exception);
    if (daRequisicao) return daRequisicao;

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Erro interno do servidor',
      codigo: 'ERRO_INTERNO',
    };
  }
}
