import { SetMetadata } from '@nestjs/common';

export const RECAPTCHA_ACAO = 'recaptchaAcao';

/**
 * Marca a rota como protegida por captcha.
 *
 * `acao` é a action da v3 que o front declara ao gerar o token
 * (`grecaptcha.execute(site_key, { action: 'login' })`). Na v2 é ignorada.
 *
 *   @Recaptcha('login')
 *   @UseGuards(RecaptchaGuard)
 */
export const Recaptcha = (acao?: string) => SetMetadata(RECAPTCHA_ACAO, acao ?? null);
