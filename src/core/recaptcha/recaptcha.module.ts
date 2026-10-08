import { Global, Module } from '@nestjs/common';

import { RecaptchaGuard } from './recaptcha.guard';
import { RecaptchaService } from './recaptcha.service';

// Global porque o guard é usado por rotas de módulos diferentes (auth e users)
// e não vale repetir o provider em cada um.
@Global()
@Module({
  providers: [RecaptchaService, RecaptchaGuard],
  exports: [RecaptchaService, RecaptchaGuard],
})
export class RecaptchaModule {}
