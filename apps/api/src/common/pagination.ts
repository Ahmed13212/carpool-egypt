import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;
export const offsetOf = (p: Pagination) => (p.page - 1) * p.pageSize;
export function pageOf<T>(items: T[], total: number, p: Pagination) {
  return { items, page: p.page, pageSize: p.pageSize, total };
}
