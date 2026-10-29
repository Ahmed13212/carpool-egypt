import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Public } from '../auth/auth.decorators';

@Controller('cities')
export class CitiesController {
  constructor(private readonly db: DatabaseService) {}

  @Public()
  @Get()
  async list() {
    const { rows } = await this.db.query(
      `SELECT id, slug, name_ar AS "nameAr", name_en AS "nameEn", governorate_en AS "governorateEn",
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
         FROM cities WHERE is_active ORDER BY name_ar`,
    );
    return rows;
  }
}
