import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { UserService } from '../../services/user.service';
import { Public } from '../../core/auth/public.decorator';
import { Recaptcha, RecaptchaGuard } from '../../core/recaptcha';
import { ApiAuth, errorSchema } from '../../swagger/decorators';
import { uploadOptions } from '../../core/upload.config';
import { persistUploadedFile } from '../../core/storage';

const userSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', example: 'Maria Silva' },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['aluno', 'professor', 'admin'] },
    institution_id: { type: 'string', format: 'uuid', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly userService: UserService) {}

  // Público: a tela de cadastro precisa criar a conta antes de existir token.
  // login/refresh/logout ficam no AuthController.
  @Public()
  @Post()
  // Rota aberta: sem captcha, qualquer script cria contas em massa.
  @Recaptcha('cadastro')
  @UseGuards(RecaptchaGuard)
  @ApiOperation({
    summary: 'Cria um usuário',
    description:
      'Rota pública, protegida por reCAPTCHA. A senha é gravada com hash argon2. ' +
      'O token do captcha é verificado no Google e descartado — nada é gravado no banco.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'email', 'password'],
      properties: {
        name: { type: 'string', example: 'Maria Silva' },
        email: { type: 'string', format: 'email', example: 'maria@unicap.br' },
        password: { type: 'string', format: 'password', example: 'senha123' },
        role: { type: 'string', enum: ['aluno', 'professor', 'admin'], default: 'aluno' },
        institutionId: { type: 'string', format: 'uuid' },
        recaptchaToken: {
          type: 'string',
          description:
            'Token do reCAPTCHA gerado no front. Obrigatório quando RECAPTCHA_SECRET ' +
            'está configurado no servidor. Aceita também os nomes captchaToken e recaptcha.',
        },
      },
    },
  })
  @ApiCreatedResponse({
    schema: {
      type: 'object',
      properties: { message: { type: 'string', example: 'created successfully' } },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Inclui as falhas de captcha: CAPTCHA_AUSENTE, CAPTCHA_INVALIDO, ' +
      'CAPTCHA_EXPIRADO (token reusado) e CAPTCHA_SCORE_BAIXO (v3).',
    schema: errorSchema('Captcha inválido', 'CAPTCHA_INVALIDO'),
  })
  async create(@Body() body: any) {
    await this.userService.create(body);
    return { message: 'created successfully' };
  }

  @Get()
  @ApiAuth()
  @ApiOperation({ summary: 'Lista todos os usuários' })
  @ApiOkResponse({ schema: { type: 'array', items: userSchema } })
  async getAll() {
    return await this.userService.getAll();
  }

  @Get(':id')
  @ApiAuth()
  @ApiOperation({ summary: 'Detalha um usuário (sem a senha)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ schema: userSchema })
  @ApiNotFoundResponse({ schema: errorSchema('Usuário não encontrado') })
  async findById(@Param('id') id: string) {
    return await this.userService.findById(id);
  }

  @Put(':id/profile')
  @ApiAuth()
  @ApiOperation({
    summary: 'Atualiza nome e/ou senha',
    description: 'Envie ao menos um dos campos. name com 2+ caracteres, password com 6+.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 2, example: 'Maria S. Silva' },
        password: { type: 'string', format: 'password', minLength: 6 },
      },
    },
  })
  @ApiOkResponse({ schema: userSchema })
  @ApiBadRequestResponse({ schema: errorSchema('Informe name ou password para atualizar') })
  async updateProfile(@Param('id') id: string, @Body() body: any) {
    return await this.userService.updateProfile(id, body);
  }

  @Post(':id/avatar')
  @ApiAuth()
  @UseInterceptors(FileInterceptor('avatar', uploadOptions))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Envia/troca a foto de perfil',
    description:
      'Aceita JPEG, PNG ou WEBP até 5 MB. Em dev grava em public/uploads; em produção sobe ' +
      'pro Vercel Blob. A foto anterior (se houver) é removida depois que a nova é salva.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['avatar'],
      properties: { avatar: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({ schema: userSchema })
  @ApiBadRequestResponse({ schema: errorSchema('Tipo de arquivo inválido. Use JPEG, PNG ou WEBP.') })
  @ApiNotFoundResponse({ schema: errorSchema('Usuário não encontrado') })
  async uploadAvatar(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Arquivo de foto é obrigatório');
    }

    const url = await persistUploadedFile(file, 'avatars');
    return await this.userService.updateAvatar(id, url);
  }
}
