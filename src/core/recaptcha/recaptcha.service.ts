import { Injectable, Logger } from '@nestjs/common';

import { HttpError } from '../httpError';

/**
 * Verificação de reCAPTCHA contra o siteverify do Google.
 *
 * NADA é persistido: o token vem no corpo, é trocado por um veredito na hora e
 * descartado. O próprio Google garante uso único — reenviar o mesmo token
 * devolve `timeout-or-duplicate` — então guardar no banco seria redundante
 * (e criaria uma tabela que só acumula lixo).
 *
 * Funciona com v2 ("não sou um robô") e v3 (score). Na v3 a resposta traz
 * `score` e `action`; na v2, não — o código trata os dois casos.
 */

const SITEVERIFY = 'https://www.google.com/recaptcha/api/siteverify';

const SECRET = process.env.RECAPTCHA_SECRET ?? '';
const MIN_SCORE = Number(process.env.RECAPTCHA_MIN_SCORE ?? 0.5);
const TIMEOUT_MS = Number(process.env.RECAPTCHA_TIMEOUT_MS ?? 8000);
const EM_PRODUCAO = process.env.NODE_ENV === 'production';

interface RespostaSiteverify {
  success: boolean;
  score?: number;
  action?: string;
  hostname?: string;
  challenge_ts?: string;
  'error-codes'?: string[];
}

// O que cada error-code do Google significa para quem está usando a tela.
// Os dois primeiros são problema NOSSO (chave errada), não do cliente.
const MOTIVOS: Record<string, { mensagem: string; status: number; codigo: string }> = {
  'missing-input-secret': {
    mensagem: 'Captcha mal configurado no servidor',
    status: 503,
    codigo: 'CAPTCHA_MAL_CONFIGURADO',
  },
  'invalid-input-secret': {
    mensagem: 'Captcha mal configurado no servidor (chave secreta inválida)',
    status: 503,
    codigo: 'CAPTCHA_MAL_CONFIGURADO',
  },
  'missing-input-response': {
    mensagem: 'Captcha não enviado',
    status: 400,
    codigo: 'CAPTCHA_AUSENTE',
  },
  'invalid-input-response': {
    mensagem: 'Captcha inválido',
    status: 400,
    codigo: 'CAPTCHA_INVALIDO',
  },
  'timeout-or-duplicate': {
    mensagem: 'Captcha expirado ou já utilizado. Refaça a verificação.',
    status: 400,
    codigo: 'CAPTCHA_EXPIRADO',
  },
  'bad-request': {
    mensagem: 'Captcha recusado pelo Google (requisição malformada)',
    status: 400,
    codigo: 'CAPTCHA_INVALIDO',
  },
};

@Injectable()
export class RecaptchaService {
  private readonly logger = new Logger(RecaptchaService.name);
  private avisouDesativado = false;

  /** Sem segredo configurado o captcha não roda — só é tolerável fora de produção. */
  get ativo(): boolean {
    return SECRET.length > 0;
  }

  /**
   * Valida o token. Não devolve nada: ou passa, ou lança HttpError.
   * `acao` só é checada na v3, onde o token carrega a ação que o front declarou.
   */
  async verificar(token: unknown, opcoes: { acao?: string; ip?: string } = {}): Promise<void> {
    if (!this.ativo) {
      // Em produção isso é falha de configuração, não "modo dev".
      if (EM_PRODUCAO) {
        throw new HttpError('Captcha obrigatório não está configurado no servidor', 503, {
          codigo: 'CAPTCHA_MAL_CONFIGURADO',
        });
      }

      if (!this.avisouDesativado) {
        this.logger.warn(
          'RECAPTCHA_SECRET não configurado: a verificação de captcha está DESATIVADA ' +
            '(aceitável apenas em desenvolvimento).',
        );
        this.avisouDesativado = true;
      }
      return;
    }

    if (typeof token !== 'string' || token.trim() === '') {
      throw new HttpError('Captcha não enviado', 400, {
        codigo: 'CAPTCHA_AUSENTE',
        campos: { recaptchaToken: 'obrigatório' },
      });
    }

    const dados = await this.consultarGoogle(token.trim(), opcoes.ip);

    if (!dados.success) {
      const codes = dados['error-codes'] ?? [];
      const motivo = codes.map((c) => MOTIVOS[c]).find(Boolean);

      if (motivo) {
        // Chave errada é erro de servidor: registra para o dev ver.
        if (motivo.status >= 500) {
          this.logger.error(`Configuração do reCAPTCHA rejeitada pelo Google: ${codes.join(', ')}`);
        }
        throw new HttpError(motivo.mensagem, motivo.status, { codigo: motivo.codigo });
      }

      throw new HttpError('Captcha inválido', 400, {
        codigo: 'CAPTCHA_INVALIDO',
        ...(codes.length ? { campos: { recaptchaToken: codes.join(', ') } } : {}),
      });
    }

    // --- v3: confere a ação declarada e o score ---------------------------
    if (opcoes.acao && dados.action && dados.action !== opcoes.acao) {
      throw new HttpError(
        `Captcha gerado para outra ação (esperado "${opcoes.acao}", recebido "${dados.action}")`,
        400,
        { codigo: 'CAPTCHA_ACAO_DIVERGENTE' },
      );
    }

    if (typeof dados.score === 'number' && dados.score < MIN_SCORE) {
      this.logger.warn(`Captcha com score baixo: ${dados.score} < ${MIN_SCORE}`);
      throw new HttpError(
        'Não foi possível confirmar que você não é um robô. Tente novamente.',
        400,
        { codigo: 'CAPTCHA_SCORE_BAIXO' },
      );
    }
  }

  private async consultarGoogle(token: string, ip?: string): Promise<RespostaSiteverify> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const corpo = new URLSearchParams({ secret: SECRET, response: token });
    if (ip) corpo.set('remoteip', ip);

    try {
      const resposta = await fetch(SITEVERIFY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: corpo,
        signal: controller.signal,
      });

      if (!resposta.ok) {
        throw new HttpError(
          `Serviço de captcha respondeu ${resposta.status}`,
          502,
          { codigo: 'CAPTCHA_INDISPONIVEL' },
        );
      }

      return (await resposta.json()) as RespostaSiteverify;
    } catch (err: any) {
      if (err instanceof HttpError) throw err;

      // Sem timeout o login ficaria pendurado esperando o Google.
      if (err?.name === 'AbortError') {
        this.logger.error(`siteverify não respondeu em ${TIMEOUT_MS}ms`);
        throw new HttpError(
          'Serviço de captcha não respondeu. Tente novamente.',
          504,
          { codigo: 'CAPTCHA_TIMEOUT' },
        );
      }

      this.logger.error(`Falha ao consultar o siteverify: ${err?.message}`);
      throw new HttpError('Não foi possível validar o captcha', 502, {
        codigo: 'CAPTCHA_INDISPONIVEL',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
