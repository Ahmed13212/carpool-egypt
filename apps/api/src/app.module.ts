import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { CitiesModule } from './cities/cities.module';
import { DatabaseModule } from './database/database.module';
import { DriversModule } from './drivers/drivers.module';
import { HealthController } from './health/health.controller';
import { SettingsModule } from './settings/settings.module';
import { TripsModule } from './trips/trips.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    SettingsModule,
    UsersModule,
    AuthModule,
    DriversModule,
    TripsModule,
    BookingsModule,
    CitiesModule,
    AdminModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
