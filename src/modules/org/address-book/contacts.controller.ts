import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
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
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import { CsvService } from '@/modules/csv-export/csv-utils/csv.service';
import {
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
import { csvCast, limitExports, MAX_CSV_BYTES } from '@/modules/org/common/csv';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { actor, parse } from '@/modules/org/orgs/parse';
import { RequirePermission } from '@/modules/org/permissions/require-permission.decorator';

const EXPORT_PAGE = 500;

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
    private readonly rateLimiter: RateLimiter,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {}

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
    await limitExports(this.rateLimiter, session.userId);
    // read before streaming: pipeline destroys the response on any error, so
    // a failure here must surface as an ordinary error response
    const first = await this.contacts.page(orgId, null, EXPORT_PAGE);
    await this.contacts.recordExport(orgId, actor(req, session.userId));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    try {
      // Same shape as the Safe export (one row per chain), plus tags
      await this.csv.toCsv(Readable.from(this.csvRows(orgId, first)), res, {
        header: true,
        cast: csvCast,
        columns: ['address', 'name', 'chainId', 'tags'].map((k) => ({
          key: k,
          header: k,
        })),
      });
    } catch (error) {
      // headers are already sent: log and cut the connection so the client sees a truncated download
      this.logger.error(
        `contacts CSV export failed mid-stream: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.destroy();
    }
  }

  private async *csvRows(
    orgId: string,
    first: Array<Contact>,
  ): AsyncGenerator<Record<string, string>> {
    let page = first;
    for (;;) {
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
      page = await this.contacts.page(
        orgId,
        page[page.length - 1].id,
        EXPORT_PAGE,
      );
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
      actor(req, session.userId),
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
      actor(req, session.userId),
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
      actor(req, session.userId),
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
      actor(req, session.userId),
    );
  }

  @Get('contact-requests')
  @RequirePermission('addressbook.view')
  listRequests(
    @Param('orgId') orgId: string,
    @Query() query: unknown,
  ): ReturnType<ContactRequestsService['list']> {
    return this.requests.list(orgId, parse(RequestsQuerySchema, query));
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
      actor(req, session.userId),
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
      actor(req, session.userId),
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
      actor(req, session.userId),
    );
  }
}
