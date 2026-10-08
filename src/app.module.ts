import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { InstitutionsModule } from './modules/institutions/institutions.module';
import { FormulariosModule } from './modules/formularios/formularios.module';
import { CanteirosModule } from './modules/canteiros/canteiros.module';
import { ListaDeFormulariosModule } from './modules/listadeformularios/listadeformularios.module';
import { UserCanteirosModule } from './modules/user-canteiros/user-canteiros.module';
import { ChecklistModule } from './modules/checklist/checklist.module';
import { MeasurementsModule } from './modules/measurements/measurements.module';
import { PhotosModule } from './modules/photos/photos.module';
import { RelatoriosModule } from './modules/relatorios/relatorios.module';
import { PlantTemplatesModule } from './modules/plant-templates/plant-templates.module';
import { TurmasModule } from './modules/turmas/turmas.module';
import { AlunoTurmaModule } from './modules/aluno-turma/aluno-turma.module';
import { AcademicPeriodsModule } from './modules/academic-periods/academic-periods.module';
import { AlunosModule } from './modules/alunos/alunos.module';
import { ResumoIaModule } from './modules/resumo-ia/resumo-ia.module';

import { JwtAuthGuard } from './core/auth/jwt-auth.guard';
import { RecaptchaModule } from './core/recaptcha';
import { HttpErrorFilter } from './core/http-exception.filter';
import { loginLimiter } from './core/rate-limit';

@Module({
  imports: [
    RecaptchaModule,
    UsersModule,
    AuthModule,
    InstitutionsModule,
    FormulariosModule,
    CanteirosModule,
    ListaDeFormulariosModule,
    UserCanteirosModule,
    ChecklistModule,
    MeasurementsModule,
    PhotosModule,
    RelatoriosModule,
    PlantTemplatesModule,
    TurmasModule,
    AlunoTurmaModule,
    AcademicPeriodsModule,
    AlunosModule,
    ResumoIaModule,
  ],
  providers: [
    // Tudo protegido por padrão; rotas abertas usam @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Converte o HttpError dos services no status HTTP correto (era 500 em tudo).
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Anti brute-force apenas no login (10 tentativas / 15 min por IP).
    consumer
      .apply(loginLimiter)
      .forRoutes({ path: 'users/login', method: RequestMethod.POST });
  }
}
