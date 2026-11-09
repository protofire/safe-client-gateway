import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { Readable } from 'stream';
import { z } from 'zod';
import { CsvService } from '@/modules/csv-export/csv-utils/csv.service';
import {
  type Actor,
  type Contact,
  ContactPatchSchema,
  ContactSchema,
  CreateRequestSchema,
  ListQuerySchema,
  RequestsQuerySchema,
} from '@/modules/org/address-book/contacts.schemas';
import { ContactRequestsService } from '@/modules/org/address-book/contact-requests.service';
import { ContactsService } from '@/modules/org/address-book/contacts.service';
import { OrgSession, RequireStrongAuth } from '@/modules/org/auth/decorators';
import { csvCast } from '@/modules/org/common/csv';
import { RequirePermission } from '@/modules/org/permissions/require-permission.decorator';

const MAX_CSV_BYTES = 1024 * 1024;
const EXPORT_PAGE = 500;

// ZodErrorFilter answers 502 (gateway upstream semantics); bad input is a 400
function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(parsed.error.message);
  return parsed.data;
}

function uuid(raw: string): string {
  if (!z.uuid().safeParse(raw).success) throw new NotFoundException();
  return raw;
}

@Controller({ path: 'orgs/:orgId', version: '1' })
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly requests: ContactRequestsService,
    private readonly csv: CsvService,
  ) {}

  private actor(req: Request, s: OrgSession): Actor {
    return { userId: s.userId, ip: req.ip, userAgent: req.get('user-agent') };
  }

  @Get('contacts')
  @RequirePermission('addressbook.view')
  list(
    @Param('orgId') orgId: string,
    @Query() query: unknown,
  ): Promise<Array<Contact>> {
    return this.contacts.list(orgId, parse(ListQuerySchema, query));
  }

  @Get('contacts.csv')
  @RequirePermission('exports.read')
  async exportCsv(
    @Req() req: Request,
    @Res() res: Response,
    @Param('orgId') orgId: string,
    @OrgSession() session: OrgSession,
  ): Promise<void> {
    await this.contacts.recordExport(orgId, this.actor(req, session));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    // Same shape as the Safe export (one row per chain), plus tags
    await this.csv.toCsv(Readable.from(this.csvRows(orgId)), res, {
      header: true,
      cast: csvCast,
      columns: ['address', 'name', 'chainId', 'tags'].map((k) => ({
        key: k,
        header: k,
      })),
    });
  }

  private async *csvRows(
    orgId: string,
  ): AsyncGenerator<Record<string, string>> {
    let after: string | null = null;
    for (;;) {
      const page = await this.contacts.page(orgId, after, EXPORT_PAGE);
      for (const c of page) {
        for (const chainId of c.chainIds) {
          yield {
            address: c.address,
            name: c.name,
            chainId,
            tags: c.tags.join(';'),
          };
        }
      }
      if (page.length < EXPORT_PAGE) return;
      after = page[page.length - 1].id;
    }
  }

  @Post('contacts')
  @RequirePermission('addressbook.write')
  @RequireStrongAuth()
  create(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<Contact> {
    return this.contacts.create(
      orgId,
      parse(ContactSchema, body),
      this.actor(req, session),
    );
  }

  @Post('contacts/import')
  @HttpCode(200)
  @RequirePermission('addressbook.write')
  @RequireStrongAuth()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES, files: 1 } }),
  )
  import(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @OrgSession() session: OrgSession,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ): ReturnType<ContactsService['import']> {
    if (!file) throw new BadRequestException('Missing CSV file field "file"');
    return this.contacts.import(
      orgId,
      file.buffer.toString('utf8'),
      this.actor(req, session),
    );
  }

  @Patch('contacts/:contactId')
  @RequirePermission('addressbook.write')
  @RequireStrongAuth()
  update(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('contactId') contactId: string,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<Contact> {
    return this.contacts.update(
      orgId,
      uuid(contactId),
      parse(ContactPatchSchema, body),
      this.actor(req, session),
    );
  }

  @Delete('contacts/:contactId')
  @HttpCode(204)
  @RequirePermission('addressbook.write')
  @RequireStrongAuth()
  remove(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('contactId') contactId: string,
    @OrgSession() session: OrgSession,
  ): Promise<void> {
    return this.contacts.remove(
      orgId,
      uuid(contactId),
      this.actor(req, session),
    );
  }

  @Get('contact-requests')
  @RequirePermission('addressbook.view')
  listRequests(
    @Param('orgId') orgId: string,
    @Query() query: unknown,
  ): ReturnType<ContactRequestsService['list']> {
    return this.requests.list(orgId, parse(RequestsQuerySchema, query).status);
  }

  @Post('contact-requests')
  @RequirePermission('addressbook.request')
  createRequest(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): ReturnType<ContactRequestsService['create']> {
    return this.requests.create(
      orgId,
      parse(CreateRequestSchema, body),
      this.actor(req, session),
    );
  }

  @Post('contact-requests/:requestId/approve')
  @HttpCode(200)
  @RequirePermission('addressbook.review')
  @RequireStrongAuth()
  approve(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('requestId') requestId: string,
    @OrgSession() session: OrgSession,
  ): ReturnType<ContactRequestsService['approve']> {
    return this.requests.approve(
      orgId,
      uuid(requestId),
      this.actor(req, session),
    );
  }

  @Post('contact-requests/:requestId/reject')
  @HttpCode(200)
  @RequirePermission('addressbook.review')
  @RequireStrongAuth()
  reject(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('requestId') requestId: string,
    @OrgSession() session: OrgSession,
  ): ReturnType<ContactRequestsService['reject']> {
    return this.requests.reject(
      orgId,
      uuid(requestId),
      this.actor(req, session),
    );
  }
}
