import { InstanceDto } from '@api/dto/instance.dto';
import { Options, Quoted, SendAudioDto, SendMediaDto, SendTextDto } from '@api/dto/sendMessage.dto';
import { ChatwootDto } from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { postgresClient } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';
import { chatwootImport } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import { PrismaRepository } from '@api/repository/repository.service';
import { CacheService } from '@api/services/cache.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Events, Integration } from '@api/types/wa.types';
import { Chatwoot, ConfigService, Database, HttpServer } from '@config/env.config';
import { Logger } from '@config/logger.config';
import ChatwootClient, {
  ChatwootAPIConfig,
  contact,
  contact_inboxes,
  conversation,
  conversation_show,
  generic_id,
  inbox,
} from '@figuro/chatwoot-sdk';
import { request as chatwootRequest } from '@figuro/chatwoot-sdk/dist/core/request';
import { Chatwoot as ChatwootModel, Contact as ContactModel, Message as MessageModel } from '@prisma/client';
import i18next from '@utils/i18n';
import { sendTelemetry } from '@utils/sendTelemetry';
import axios from 'axios';
import { WAMessageContent, WAMessageKey } from 'baileys';
import dayjs from 'dayjs';
import FormData from 'form-data';
import { Jimp, JimpMime } from 'jimp';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import Long from 'long';
import mimeTypes from 'mime-types';
import path from 'path';
import { Readable } from 'stream';

interface ChatwootMessage {
  messageId?: number;
  inboxId?: number;
  conversationId?: number;
  contactInboxSourceId?: string;
  isRead?: boolean;
}

export class ChatwootService {
  private readonly logger = new Logger('ChatwootService');

  // Lock polling delay
  private readonly LOCK_POLLING_DELAY_MS = 300; // Delay between lock status checks

  private provider: any;

  // Cache para deduplicação de orderMessage (evita mensagens duplicadas)
  private processedOrderIds: Map<string, number> = new Map();
  private readonly ORDER_CACHE_TTL_MS = 30000; // 30 segundos

  // Cache para mapeamento LID → Número Normal (resolve problema de @lid)
  private lidToPhoneMap: Map<string, { phone: string; timestamp: number }> = new Map();
  private readonly LID_CACHE_TTL_MS = 3600000; // 1 hora

  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
    private readonly cache: CacheService,
  ) {}

  private pgClient = postgresClient.getChatwootConnection();

  private async getProvider(instance: InstanceDto): Promise<ChatwootModel | null> {
    const cacheKey = `${instance.instanceName}:getProvider`;
    if (await this.cache.has(cacheKey)) {
      const provider = (await this.cache.get(cacheKey)) as ChatwootModel;

      return provider;
    }

    const provider = await this.waMonitor.waInstances[instance.instanceName]?.findChatwoot();

    if (!provider) {
      this.logger.warn('provider not found');
      return null;
    }

    this.cache.set(cacheKey, provider);

    return provider;
  }

  private async clientCw(instance: InstanceDto) {
    const provider = await this.getProvider(instance);

    if (!provider) {
      this.logger.error('provider not found');
      return null;
    }

    this.provider = provider;

    const client = new ChatwootClient({
      config: this.getClientCwConfig(),
    });

    return client;
  }

  public getClientCwConfig(): ChatwootAPIConfig & { nameInbox: string; mergeBrazilContacts: boolean } {
    return {
      basePath: this.provider.url,
      with_credentials: true,
      credentials: 'include',
      token: this.provider.token,
      nameInbox: this.provider.nameInbox,
      mergeBrazilContacts: this.provider.mergeBrazilContacts,
    };
  }

  public getCache() {
    return this.cache;
  }

  public async create(instance: InstanceDto, data: ChatwootDto) {
    await this.waMonitor.waInstances[instance.instanceName].setChatwoot(data);

    if (data.autoCreate) {
      this.logger.log('Auto create chatwoot instance');
      const urlServer = this.configService.get<HttpServer>('SERVER').URL;

      await this.initInstanceChatwoot(
        instance,
        data.nameInbox ?? instance.instanceName.split('-cwId-')[0],
        `${urlServer}/chatwoot/webhook/${encodeURIComponent(instance.instanceName)}`,
        true,
        data.number,
        data.organization,
        data.logo,
      );
    }
    return data;
  }

  public async find(instance: InstanceDto): Promise<ChatwootDto> {
    try {
      return await this.waMonitor.waInstances[instance.instanceName].findChatwoot();
    } catch {
      this.logger.error('chatwoot not found');
      return { enabled: null, url: '' };
    }
  }

  public async getContact(instance: InstanceDto, id: number) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    if (!id) {
      this.logger.warn('id is required');
      return null;
    }

    const contact = await client.contact.getContactable({
      accountId: this.provider.accountId,
      id,
    });

    if (!contact) {
      this.logger.warn('contact not found');
      return null;
    }

    return contact;
  }

  public async initInstanceChatwoot(
    instance: InstanceDto,
    inboxName: string,
    webhookUrl: string,
    qrcode: boolean,
    number: string,
    organization?: string,
    logo?: string,
  ) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    const findInbox: any = await client.inboxes.list({
      accountId: this.provider.accountId,
    });

    const checkDuplicate = findInbox.payload.map((inbox) => inbox.name).includes(inboxName);

    let inboxId: number;

    this.logger.log('Creating chatwoot inbox');
    if (!checkDuplicate) {
      const data = {
        type: 'api',
        webhook_url: webhookUrl,
      };

      const inbox = await client.inboxes.create({
        accountId: this.provider.accountId,
        data: {
          name: inboxName,
          channel: data as any,
        },
      });

      if (!inbox) {
        this.logger.warn('inbox not found');
        return null;
      }

      inboxId = inbox.id;
    } else {
      const inbox = findInbox.payload.find((inbox) => inbox.name === inboxName);

      if (!inbox) {
        this.logger.warn('inbox not found');
        return null;
      }

      inboxId = inbox.id;
    }
    this.logger.log(`Inbox created - inboxId: ${inboxId}`);

    if (!this.configService.get<Chatwoot>('CHATWOOT').BOT_CONTACT) {
      this.logger.log('Chatwoot bot contact is disabled');

      return true;
    }

    this.logger.log('Creating chatwoot bot contact');
    const contact =
      (await this.findContact(instance, '123456')) ||
      ((await this.createContact(
        instance,
        '123456',
        inboxId,
        false,
        organization ? organization : 'EvolutionAPI',
        logo ? logo : 'https://evolution-api.com/files/evolution-api-favicon.png',
      )) as any);

    if (!contact) {
      this.logger.warn('contact not found');
      return null;
    }

    const contactId = contact.id || contact.payload.contact.id;
    this.logger.log(`Contact created - contactId: ${contactId}`);

    if (qrcode) {
      this.logger.log('QR code enabled');
      const data = {
        contact_id: contactId.toString(),
        inbox_id: inboxId.toString(),
      };

      const conversation = await client.conversations.create({
        accountId: this.provider.accountId,
        data,
      });

      if (!conversation) {
        this.logger.warn('conversation not found');
        return null;
      }

      let contentMsg = 'init';

      if (number) {
        contentMsg = `init:${number}`;
      }

      const message = await client.messages.create({
        accountId: this.provider.accountId,
        conversationId: conversation.id,
        data: {
          content: contentMsg,
          message_type: 'outgoing',
        },
      });

      if (!message) {
        this.logger.warn('conversation not found');
        return null;
      }
      this.logger.log('Init message sent');
    }

    return true;
  }

  public async createContact(
    instance: InstanceDto,
    phoneNumber: string,
    inboxId: number,
    isGroup: boolean,
    name?: string,
    avatar_url?: string,
    jid?: string,
  ) {
    try {
      const client = await this.clientCw(instance);

      if (!client) {
        this.logger.warn('client not found');
        return null;
      }

      let data: any = {};
      if (!isGroup) {
        data = {
          inbox_id: inboxId,
          name: name || phoneNumber,
          identifier: jid,
          avatar_url: avatar_url,
        };

        if ((jid && jid.includes('@')) || !jid) {
          data['phone_number'] = `+${phoneNumber}`;
        }

        // 🔴 PARCHE PD (5 sep 2026): QUIEN OCULTA SU NÚMERO EN WHATSAPP LLEGA
        // SIN TELÉFONO, Y EL QUE SE GUARDA NO SIRVE PARA NADA.
        //
        // WhatsApp dejó que la gente esconda su número y use un nombre de
        // usuario. Cuando escriben, no viene el teléfono: viene un
        // identificador largo acabado en `@lid`. Como aquí hay que rellenar
        // `phone_number` sí o sí, acaba guardándose ese identificador con un
        // `+` delante: `+105828497510423`. Parece un teléfono, no lo es, y un
        // `wa.me/105828497510423` no abre ninguna conversación — cuelga el
        // WhatsApp Web.
        //
        // Lo vio Luis: *«puede ser que esas numeraciones largas que sí que nos
        // parecen teléfonos sean usuarios que tienen oculto su número y tienen,
        // más bien, nombre de usuario»*. Era exactamente eso.
        //
        // No se toca el teléfono —cambiarlo rompería la búsqueda por
        // `phone_number` de la que depende medio flujo— pero se guarda al lado
        // **el usuario, que es por donde SÍ se le puede escribir**, y el `@lid`
        // para que quien mire la ficha entienda por qué ese número es raro.
        // Chatwoot los enseña en la ficha del contacto y en la conversación.
        if (jid && jid.includes('@lid')) {
          data['custom_attributes'] = {
            whatsapp_usuario: name || null,
            whatsapp_lid: jid,
          };
        }
      } else {
        data = {
          inbox_id: inboxId,
          name: name || phoneNumber,
          identifier: phoneNumber,
          avatar_url: avatar_url,
        };
      }

      const contact = await client.contacts.create({
        accountId: this.provider.accountId,
        data,
      });

      if (!contact) {
        this.logger.warn('contact not found');
        return null;
      }

      const findContact = await this.findContact(instance, phoneNumber);

      const contactId = findContact?.id;

      await this.addLabelToContact(this.provider.nameInbox, contactId);

      return contact;
    } catch (error) {
      if ((error.status === 422 || error.response?.status === 422) && jid) {
        this.logger.warn(`Contact with identifier ${jid} creation failed (422). Checking if it already exists...`);
        const existingContact = await this.findContactByIdentifier(instance, jid);
        if (existingContact) {
          const contactId = existingContact.id;
          await this.addLabelToContact(this.provider.nameInbox, contactId);
          return existingContact;
        }
      }

      this.logger.error('Error creating contact');
      console.log(error);
      return null;
    }
  }

  public async updateContact(instance: InstanceDto, id: number, data: any) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    if (!id) {
      this.logger.warn('id is required');
      return null;
    }

    try {
      const contact = await client.contacts.update({
        accountId: this.provider.accountId,
        id,
        data,
      });

      return contact;
    } catch {
      return null;
    }
  }

  public async addLabelToContact(nameInbox: string, contactId: number) {
    try {
      const uri = this.configService.get<Chatwoot>('CHATWOOT').IMPORT.DATABASE.CONNECTION.URI;

      if (!uri) return false;

      const sqlTags = `SELECT id, taggings_count FROM tags WHERE name = $1 LIMIT 1`;
      const tagData = (await this.pgClient.query(sqlTags, [nameInbox]))?.rows[0];
      let tagId = tagData?.id;
      const taggingsCount = tagData?.taggings_count || 0;

      const sqlTag = `INSERT INTO tags (name, taggings_count) 
                      VALUES ($1, $2) 
                      ON CONFLICT (name) 
                      DO UPDATE SET taggings_count = tags.taggings_count + 1 
                      RETURNING id`;

      tagId = (await this.pgClient.query(sqlTag, [nameInbox, taggingsCount + 1]))?.rows[0]?.id;

      const sqlCheckTagging = `SELECT 1 FROM taggings 
                               WHERE tag_id = $1 AND taggable_type = 'Contact' AND taggable_id = $2 AND context = 'labels' LIMIT 1`;

      const taggingExists = (await this.pgClient.query(sqlCheckTagging, [tagId, contactId]))?.rowCount > 0;

      if (!taggingExists) {
        const sqlInsertLabel = `INSERT INTO taggings (tag_id, taggable_type, taggable_id, context, created_at) 
                                VALUES ($1, 'Contact', $2, 'labels', NOW())`;

        await this.pgClient.query(sqlInsertLabel, [tagId, contactId]);
      }

      return true;
    } catch {
      return false;
    }
  }

  public async findContactByIdentifier(instance: InstanceDto, identifier: string) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    // Direct search by query (q) - most common way to search by identifier/email/phone
    //
    // 🔴 PARCHE PD (5 sep 2026): esto llamaba a `(client as any).get(...)`, y el
    // cliente del SDK NO TIENE un método `get` genérico — el `as any` era lo
    // único que dejaba compilarlo. En ejecución reventaba SIEMPRE con
    // `TypeError: t.get is not a function`, que el `catch` de `resolveLidToPhone`
    // se tragaba como un simple `warn`. Resultado: ningún `@lid` se resolvía
    // nunca, y los mensajes entrantes de WhatsApp con identificador nuevo no
    // encontraban a su contacto.
    //
    // Medido en la VPS2 el 5 sep 2026: **184 fallos de resolución en 12 horas**
    // y 172 contactos duplicados creados con nombre numérico (`105828497510423`)
    // repartidos entre las cuatro clínicas — 150 solo en Dentística.
    //
    // El propio archivo ya usa la forma buena 60 líneas más abajo
    // (`client.contacts.search({ accountId, q })`), que es la del SDK.
    const contact = (await client.contacts.search({
      accountId: this.provider.accountId,
      q: identifier,
      sort: 'name',
    })) as any;

    if (contact && contact.data && contact.data.payload && contact.data.payload.length > 0) {
      return contact.data.payload[0];
    }

    // Fallback for older API versions or different response structures
    if (contact && contact.payload && contact.payload.length > 0) {
      return contact.payload[0];
    }

    // Try search by attribute
    //
    // 🔴 PARCHE PD (5 sep 2026): mismo fallo que arriba, con `post` en vez de
    // `get`. Este camino casi nunca se llegaba a pisar —el de arriba reventaba
    // antes— pero estaba igual de roto, y arreglar solo uno habría dejado la
    // segunda mitad de la función esperando su turno para fallar.
    const contactByAttr = (await client.contacts.filter({
      accountId: this.provider.accountId,
      payload: [
        {
          attribute_key: 'identifier',
          filter_operator: 'equal_to',
          values: [identifier],
          query_operator: null,
        },
      ],
    })) as any;

    if (contactByAttr && contactByAttr.payload && contactByAttr.payload.length > 0) {
      return contactByAttr.payload[0];
    }

    // Check inside data property if using axios interceptors wrapper
    if (contactByAttr && contactByAttr.data && contactByAttr.data.payload && contactByAttr.data.payload.length > 0) {
      return contactByAttr.data.payload[0];
    }

    return null;
  }

  public async findContact(instance: InstanceDto, phoneNumber: string) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    let query: any;
    const isGroup = phoneNumber.includes('@g.us');

    if (!isGroup) {
      query = `+${phoneNumber}`;
    } else {
      query = phoneNumber;
    }

    let contact: any;

    if (isGroup) {
      contact = await client.contacts.search({
        accountId: this.provider.accountId,
        q: query,
      });
    } else {
      contact = await chatwootRequest(this.getClientCwConfig(), {
        method: 'POST',
        url: `/api/v1/accounts/${this.provider.accountId}/contacts/filter`,
        body: {
          payload: this.getFilterPayload(query),
        },
      });
    }

    if (!contact && contact?.payload?.length === 0) {
      this.logger.warn('contact not found');
      return null;
    }

    if (!isGroup) {
      return contact.payload.length > 1 ? this.findContactInContactList(contact.payload, query) : contact.payload[0];
    } else {
      return contact.payload.find((contact) => contact.identifier === query);
    }
  }

  private async mergeContacts(baseId: number, mergeId: number) {
    try {
      const contact = await chatwootRequest(this.getClientCwConfig(), {
        method: 'POST',
        url: `/api/v1/accounts/${this.provider.accountId}/actions/contact_merge`,
        body: {
          base_contact_id: baseId,
          mergee_contact_id: mergeId,
        },
      });

      return contact;
    } catch {
      this.logger.error('Error merging contacts');
      return null;
    }
  }

  private async mergeBrazilianContacts(contacts: any[]) {
    try {
      const contact = await chatwootRequest(this.getClientCwConfig(), {
        method: 'POST',
        url: `/api/v1/accounts/${this.provider.accountId}/actions/contact_merge`,
        body: {
          base_contact_id: contacts.find((contact) => contact.phone_number.length === 14)?.id,
          mergee_contact_id: contacts.find((contact) => contact.phone_number.length === 13)?.id,
        },
      });

      return contact;
    } catch {
      this.logger.error('Error merging contacts');
      return null;
    }
  }

  private findContactInContactList(contacts: any[], query: string) {
    const phoneNumbers = this.getNumbers(query);
    const searchableFields = this.getSearchableFields();

    // eslint-disable-next-line prettier/prettier
    if (contacts.length === 2 && this.getClientCwConfig().mergeBrazilContacts && query.startsWith('+55')) {
      const contact = this.mergeBrazilianContacts(contacts);
      if (contact) {
        return contact;
      }
    }

    const phone = phoneNumbers.reduce(
      (savedNumber, number) => (number.length > savedNumber.length ? number : savedNumber),
      '',
    );

    const contact_with9 = contacts.find((contact) => contact.phone_number === phone);
    if (contact_with9) {
      return contact_with9;
    }

    for (const contact of contacts) {
      for (const field of searchableFields) {
        if (contact[field] && phoneNumbers.includes(contact[field])) {
          return contact;
        }
      }
    }

    return null;
  }

  private getNumbers(query: string) {
    const numbers = [];
    numbers.push(query);

    if (query.startsWith('+55') && query.length === 14) {
      const withoutNine = query.slice(0, 5) + query.slice(6);
      numbers.push(withoutNine);
    } else if (query.startsWith('+55') && query.length === 13) {
      const withNine = query.slice(0, 5) + '9' + query.slice(5);
      numbers.push(withNine);
    }

    return numbers;
  }

  private getSearchableFields() {
    return ['phone_number'];
  }

  private getFilterPayload(query: string) {
    const filterPayload = [];

    const numbers = this.getNumbers(query);
    const fieldsToSearch = this.getSearchableFields();

    fieldsToSearch.forEach((field, index1) => {
      numbers.forEach((number, index2) => {
        const queryOperator = fieldsToSearch.length - 1 === index1 && numbers.length - 1 === index2 ? null : 'OR';
        filterPayload.push({
          attribute_key: field,
          filter_operator: 'equal_to',
          values: [number.replace('+', '')],
          query_operator: queryOperator,
        });
      });
    });

    return filterPayload;
  }

  public async createConversation(instance: InstanceDto, body: any) {
    const isLid = body.key.addressingMode === 'lid';
    const isGroup = body.key.remoteJid.endsWith('@g.us');
    let phoneNumber = isLid && !isGroup ? body.key.remoteJidAlt : body.key.remoteJid;
    const { remoteJid } = body.key;

    // CORREÇÃO LID: Resolve LID para número normal antes de processar
    if (isLid && !isGroup) {
      const resolvedPhone = await this.resolveLidToPhone(instance, body.key);

      if (resolvedPhone && resolvedPhone !== remoteJid) {
        this.logger.verbose(`LID detected and resolved: ${remoteJid} → ${resolvedPhone}`);
        phoneNumber = resolvedPhone;

        // Salva mapeamento se temos remoteJidAlt
        if (body.key.remoteJidAlt) {
          this.saveLidMapping(remoteJid, body.key.remoteJidAlt);
        }
      } else if (body.key.remoteJidAlt) {
        // Se não resolveu mas tem remoteJidAlt, usa ele
        phoneNumber = body.key.remoteJidAlt;
        this.saveLidMapping(remoteJid, body.key.remoteJidAlt);
        this.logger.verbose(`Using remoteJidAlt for LID: ${remoteJid} → ${phoneNumber}`);
      }
    }

    // Usa phoneNumber como base para cache (não o LID)
    const cacheKey = `${instance.instanceName}:createConversation-${phoneNumber}`;
    const lockKey = `${instance.instanceName}:lock:createConversation-${phoneNumber}`;
    const maxWaitTime = 5000; // 5 seconds
    const client = await this.clientCw(instance);
    if (!client) return null;

    try {
      // Processa atualização de contatos já criados @lid
      if (phoneNumber && remoteJid && !isGroup) {
        const contact = await this.findContact(instance, phoneNumber.split('@')[0]);
        if (contact && contact.identifier !== remoteJid) {
          this.logger.verbose(
            `Identifier needs update: (contact.identifier: ${contact.identifier}, phoneNumber: ${phoneNumber}, body.key.remoteJidAlt: ${remoteJid}`,
          );
          const updateContact = await this.updateContact(instance, contact.id, {
            identifier: phoneNumber,
            phone_number: `+${phoneNumber.split('@')[0]}`,
          });

          if (updateContact === null) {
            const baseContact = await this.findContact(instance, phoneNumber.split('@')[0]);
            if (baseContact) {
              await this.mergeContacts(baseContact.id, contact.id);
              this.logger.verbose(
                `Merge contacts: (${baseContact.id}) ${baseContact.phone_number} and (${contact.id}) ${contact.phone_number}`,
              );
            }
          }
        }
      }
      this.logger.verbose(`--- Start createConversation ---`);
      this.logger.verbose(`Instance: ${JSON.stringify(instance)}`);

      // If it already exists in the cache, return conversationId
      if (await this.cache.has(cacheKey)) {
        const conversationId = (await this.cache.get(cacheKey)) as number;
        this.logger.verbose(`Found conversation to: ${phoneNumber}, conversation ID: ${conversationId}`);
        let conversationExists: any;
        try {
          conversationExists = await client.conversations.get({
            accountId: this.provider.accountId,
            conversationId: conversationId,
          });
          this.logger.verbose(
            `Conversation exists: ID: ${conversationExists.id} - Name: ${conversationExists.meta.sender.name} - Identifier: ${conversationExists.meta.sender.identifier}`,
          );
        } catch (error) {
          this.logger.error(`Error getting conversation: ${error}`);
          conversationExists = false;
        }
        if (!conversationExists) {
          this.logger.verbose('Conversation does not exist, re-calling createConversation');
          this.cache.delete(cacheKey);
          return await this.createConversation(instance, body);
        }
        return conversationId;
      }

      // If lock already exists, wait until release or timeout
      if (await this.cache.has(lockKey)) {
        this.logger.verbose(`Operação de criação já em andamento para ${remoteJid}, aguardando resultado...`);
        const start = Date.now();
        while (await this.cache.has(lockKey)) {
          if (Date.now() - start > maxWaitTime) {
            this.logger.warn(`Timeout aguardando lock para ${remoteJid}`);
            break;
          }
          await new Promise((res) => setTimeout(res, this.LOCK_POLLING_DELAY_MS));
          if (await this.cache.has(cacheKey)) {
            const conversationId = (await this.cache.get(cacheKey)) as number;
            this.logger.verbose(`Resolves creation of: ${remoteJid}, conversation ID: ${conversationId}`);
            return conversationId;
          }
        }
      }

      // Adquire lock
      await this.cache.set(lockKey, true, 30);
      this.logger.verbose(`Bloqueio adquirido para: ${lockKey}`);

      try {
        /*
        Double check after lock
        Utilizei uma nova verificação para evitar que outra thread execute entre o terminio do while e o set lock
        */
        if (await this.cache.has(cacheKey)) {
          return (await this.cache.get(cacheKey)) as number;
        }

        const chatId = isGroup ? remoteJid : phoneNumber.split('@')[0].split(':')[0];
        let nameContact = !body.key.fromMe ? body.pushName : chatId;
        const filterInbox = await this.getInbox(instance);
        if (!filterInbox) return null;

        if (isGroup) {
          this.logger.verbose(`Processing group conversation`);
          const group = await this.waMonitor.waInstances[instance.instanceName].client.groupMetadata(chatId);
          this.logger.verbose(`Group metadata: JID:${group.JID} - Subject:${group?.subject || group?.Name}`);

          const participantJid = isLid && !body.key.fromMe ? body.key.participantAlt : body.key.participant;
          nameContact = `${group.subject} (GROUP)`;

          const picture_url = await this.waMonitor.waInstances[instance.instanceName].profilePicture(
            participantJid.split('@')[0],
          );
          this.logger.verbose(`Participant profile picture URL: ${JSON.stringify(picture_url)}`);

          const findParticipant = await this.findContact(instance, participantJid.split('@')[0]);

          if (findParticipant) {
            this.logger.verbose(
              `Found participant: ID:${findParticipant.id} - Name: ${findParticipant.name} - identifier: ${findParticipant.identifier}`,
            );
            if (!findParticipant.name || findParticipant.name === chatId) {
              await this.updateContact(instance, findParticipant.id, {
                name: body.pushName,
                avatar_url: picture_url.profilePictureUrl || null,
              });
            }
          } else {
            await this.createContact(
              instance,
              participantJid.split('@')[0].split(':')[0],
              filterInbox.id,
              false,
              body.pushName,
              picture_url.profilePictureUrl || null,
              participantJid,
            );
          }
        }

        const picture_url = await this.waMonitor.waInstances[instance.instanceName].profilePicture(chatId);
        this.logger.verbose(`Contact profile picture URL: ${JSON.stringify(picture_url)}`);

        this.logger.verbose(`Searching contact for: ${chatId}`);
        let contact = await this.findContact(instance, chatId);

        if (contact) {
          this.logger.verbose(`Found contact: ID:${contact.id} - Name:${contact.name}`);
          if (!body.key.fromMe) {
            const waProfilePictureFile =
              picture_url?.profilePictureUrl?.split('#')[0].split('?')[0].split('/').pop() || '';
            const chatwootProfilePictureFile = contact?.thumbnail?.split('#')[0].split('?')[0].split('/').pop() || '';
            const pictureNeedsUpdate = waProfilePictureFile !== chatwootProfilePictureFile;
            const nameNeedsUpdate = !contact.name || contact.name === chatId;
            // 🔴 PARCHE PD (5 sep 2026): el usuario de WhatsApp también se pone
            // al día en un contacto que YA existe. Los `@lid` viejos se crearon
            // sin este dato, así que sin esto se quedarían para siempre con su
            // teléfono inservible y sin forma de saber a quién pertenecen: solo
            // lo tendrían los que entren de cero a partir de ahora. Ver el
            // porqué completo en `createContact`.
            const esLid = typeof body.key?.remoteJid === 'string' && body.key.remoteJid.includes('@lid');
            const usuarioNeedsUpdate =
              esLid && !!nameContact && contact.custom_attributes?.whatsapp_usuario !== nameContact;
            this.logger.verbose(`Picture needs update: ${pictureNeedsUpdate}`);
            this.logger.verbose(`Name needs update: ${nameNeedsUpdate}`);
            if (pictureNeedsUpdate || nameNeedsUpdate || usuarioNeedsUpdate) {
              contact = await this.updateContact(instance, contact.id, {
                ...(nameNeedsUpdate && { name: nameContact }),
                ...(waProfilePictureFile === '' && { avatar: null }),
                ...(pictureNeedsUpdate && { avatar_url: picture_url?.profilePictureUrl }),
                ...(usuarioNeedsUpdate && {
                  custom_attributes: {
                    ...(contact.custom_attributes || {}),
                    whatsapp_usuario: nameContact,
                    whatsapp_lid: body.key.remoteJid,
                  },
                }),
              });
            }
          }
        } else {
          contact = await this.createContact(
            instance,
            chatId,
            filterInbox.id,
            isGroup,
            nameContact,
            picture_url.profilePictureUrl || null,
            phoneNumber,
          );
        }

        if (!contact) {
          this.logger.warn(`Contact not created or found`);
          return null;
        }

        const contactId = contact?.payload?.id || contact?.payload?.contact?.id || contact?.id;
        this.logger.verbose(`Contact ID: ${contactId}`);

        const contactConversations = (await client.contacts.listConversations({
          accountId: this.provider.accountId,
          id: contactId,
        })) as any;

        if (!contactConversations || !contactConversations.payload) {
          this.logger.error(`No conversations found or payload is undefined`);
          return null;
        }

        let inboxConversation = contactConversations.payload.find(
          (conversation) => conversation.inbox_id == filterInbox.id,
        );
        if (inboxConversation) {
          if (this.provider.reopenConversation) {
            this.logger.verbose(
              `Found conversation in reopenConversation mode: ID: ${inboxConversation.id} - Name: ${inboxConversation.meta.sender.name} - Identifier: ${inboxConversation.meta.sender.identifier}`,
            );
            if (inboxConversation && this.provider.conversationPending && inboxConversation.status !== 'open') {
              await client.conversations.toggleStatus({
                accountId: this.provider.accountId,
                conversationId: inboxConversation.id,
                data: {
                  status: 'pending',
                },
              });
            }
          } else {
            inboxConversation = contactConversations.payload.find(
              (conversation) =>
                conversation && conversation.status !== 'resolved' && conversation.inbox_id == filterInbox.id,
            );
            this.logger.verbose(`Found conversation: ${JSON.stringify(inboxConversation)}`);
          }

          if (inboxConversation) {
            this.logger.verbose(`Returning existing conversation ID: ${inboxConversation.id}`);
            this.cache.set(cacheKey, inboxConversation.id, 1800);
            return inboxConversation.id;
          }
        }

        const data = {
          contact_id: contactId.toString(),
          inbox_id: filterInbox.id.toString(),
        };

        if (this.provider.conversationPending) {
          data['status'] = 'pending';
        }

        const conversation = await client.conversations.create({
          accountId: this.provider.accountId,
          data,
        });

        if (!conversation) {
          this.logger.warn(`Conversation not created or found`);
          return null;
        }

        this.logger.verbose(`New conversation created of ${remoteJid} with ID: ${conversation.id}`);
        this.cache.set(cacheKey, conversation.id, 1800);
        return conversation.id;
      } finally {
        await this.cache.delete(lockKey);
        this.logger.verbose(`Block released for: ${lockKey}`);
      }
    } catch (error) {
      this.logger.error(`Error in createConversation: ${error}`);
      return null;
    }
  }

  public async getInbox(instance: InstanceDto): Promise<inbox | null> {
    const cacheKey = `${instance.instanceName}:getInbox`;
    if (await this.cache.has(cacheKey)) {
      return (await this.cache.get(cacheKey)) as inbox;
    }

    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    const inbox = (await client.inboxes.list({
      accountId: this.provider.accountId,
    })) as any;

    if (!inbox) {
      this.logger.warn('inbox not found');
      return null;
    }

    const findByName = inbox.payload.find((inbox) => inbox.name === this.getClientCwConfig().nameInbox);

    if (!findByName) {
      this.logger.warn('inbox not found');
      return null;
    }

    this.cache.set(cacheKey, findByName);
    return findByName;
  }

  public async createMessage(
    instance: InstanceDto,
    conversationId: number,
    content: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    privateMessage?: boolean,
    attachments?: {
      content: unknown;
      encoding: string;
      filename: string;
    }[],
    messageBody?: any,
    sourceId?: string,
    quotedMsg?: MessageModel,
    // PD: estructura del mensaje interactivo (botones, lista, PIX, catálogo) para que Chatwoot lo
    // pinte como tarjeta en vez de como texto. Viaja en `content_attributes.pd_interactivo`.
    interactivo?: Record<string, any>,
  ) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    const replyToIds = await this.getReplyToIds(messageBody, instance);

    const sourceReplyId = quotedMsg?.chatwootMessageId || null;

    // Filtra valores null/undefined do content_attributes para evitar erro 406
    const filteredReplyToIds = Object.fromEntries(Object.entries(replyToIds).filter(([, value]) => value != null));

    // Monta o objeto data, incluindo content_attributes apenas se houver dados válidos
    const messageData: any = {
      content: content,
      message_type: messageType,
      content_type: 'text', // Explicitamente define como texto para Chatwoot 4.x
      attachments: attachments,
      private: privateMessage || false,
    };

    // Adiciona source_id apenas se existir
    if (sourceId) {
      messageData.source_id = sourceId;
    }

    // Adiciona content_attributes apenas se houver dados válidos
    if (Object.keys(filteredReplyToIds).length > 0) {
      messageData.content_attributes = filteredReplyToIds;
    }

    // 🔴 UN MENSAJE QUE SALIÓ FUERA DE CHATWOOT SE MARCA COMO TAL.
    //
    // Todo `outgoing` que llega hasta aquí viene del socket de WhatsApp
    // (`messageType = body.key.fromMe ? 'outgoing' : 'incoming'`), o sea que lo
    // escribió alguien desde el teléfono, desde WhatsApp Web o desde el chat de
    // la propia Evolution. Lo que se escribe DENTRO de Chatwoot no pasa por
    // aquí: Chatwoot ya lo tiene.
    //
    // Sin esta marca, Chatwoot no sabe que vino de fuera y hace lo único que
    // puede: atribuirlo al dueño del token con el que Evolution le habla. En la
    // agencia eso ponía 2.705 mensajes en 7 días a nombre de una persona que no
    // atiende a nadie, y el chat decía «Enviado por: Fulano» sin que Fulano
    // hubiera escrito nada.
    //
    // `external_echo` es un campo que Chatwoot YA usa para esto en sus propios
    // canales (Facebook, Instagram, TikTok y la API oficial de WhatsApp: ver
    // `app/services/whatsapp/incoming_message_base_service.rb`). Al verlo, la
    // pantalla pinta el icono de la bandeja en vez del avatar del usuario y
    // avisa de que el mensaje salió por fuera. Lo único que faltaba era que
    // alguien se lo dijera.
    if (messageType === 'outgoing') {
      messageData.content_attributes = {
        ...(messageData.content_attributes || {}),
        external_echo: true,
      };
    }

    // PD: la estructura del interactivo, si la hay. El `content` sigue llevando el texto de
    // siempre: es lo que se lee en el correo de notificación, en el buscador y en cualquier
    // cliente que no sea nuestro fork.
    if (interactivo) {
      messageData.content_attributes = {
        ...(messageData.content_attributes || {}),
        pd_interactivo: interactivo,
      };
    }

    // Adiciona source_reply_id apenas se existir
    if (sourceReplyId) {
      messageData.source_reply_id = sourceReplyId.toString();
    }

    const message = await client.messages.create({
      accountId: this.provider.accountId,
      conversationId: conversationId,
      data: messageData,
    });

    if (!message) {
      this.logger.warn('message not found');
      return null;
    }

    return message;
  }

  public async getOpenConversationByContact(
    instance: InstanceDto,
    inbox: inbox,
    contact: generic_id & contact,
  ): Promise<conversation> {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    const conversations = (await client.contacts.listConversations({
      accountId: this.provider.accountId,
      id: contact.id,
    })) as any;

    return (
      conversations.payload.find(
        (conversation) => conversation.inbox_id === inbox.id && conversation.status === 'open',
      ) || undefined
    );
  }

  public async createBotMessage(
    instance: InstanceDto,
    content: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    attachments?: {
      content: unknown;
      encoding: string;
      filename: string;
    }[],
  ) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    const contact = await this.findContact(instance, '123456');

    if (!contact) {
      this.logger.warn('contact not found');
      return null;
    }

    const filterInbox = await this.getInbox(instance);

    if (!filterInbox) {
      this.logger.warn('inbox not found');
      return null;
    }

    const conversation = await this.getOpenConversationByContact(instance, filterInbox, contact);

    if (!conversation) {
      this.logger.warn('conversation not found');
      return;
    }

    const message = await client.messages.create({
      accountId: this.provider.accountId,
      conversationId: conversation.id,
      data: {
        content: content,
        message_type: messageType,
        attachments: attachments,
      },
    });

    if (!message) {
      this.logger.warn('message not found');
      return null;
    }

    return message;
  }

  /**
   * PD: manda a Chatwoot un interactivo que trae imágenes —el catálogo, con una por tarjeta, o unos
   * botones con su logo de cabecera—.
   *
   * Las imágenes de WhatsApp van **cifradas**: no basta con la URL, hay que descargarlas con la
   * `mediaKey` del propio mensaje. Se suben como varios `attachments[]` del MISMO mensaje y la
   * estructura anota, por posición, cuál va con cada cosa.
   *
   * 🔴 Devuelve `false` si algo falla, para que quien llama siga por el camino de texto: un catálogo
   * sin fotos se lee mal, pero un mensaje que no llega no se lee en absoluto.
   */
  private async enviarInteractivoConImagenes(
    instance: InstanceDto,
    waInstance: any,
    conversationId: number,
    messageType: 'incoming' | 'outgoing',
    body: any,
    estructura: Record<string, any>,
    imagenes: Array<{ imagen: any; anotar: (indice: number) => void }>,
    texto: string,
  ): Promise<any> {
    try {
      const data = new FormData();
      let subidas = 0;

      for (const { imagen, anotar } of imagenes) {
        if (!imagen) continue;

        // Se le pasa un mensaje armado a mano con SOLO esa imagen: el descargador de Baileys
        // necesita la `key` original para descifrarla.
        const media = await waInstance?.getBase64FromMediaMessage({
          message: { key: body.key, message: { imageMessage: imagen } },
        });

        if (!media?.base64) {
          this.logger.warn('[PD] no se pudo bajar una imagen del interactivo');
          continue;
        }

        const flujo = new Readable();
        flujo._read = () => {};
        flujo.push(Buffer.from(media.base64, 'base64'));
        flujo.push(null);

        const extension = mimeTypes.extension(media.mimetype) || 'jpg';

        data.append('attachments[]', flujo, { filename: `whatsapp-${subidas + 1}.${extension}` });
        anotar(subidas);
        subidas += 1;
      }

      if (!subidas) return false;

      const atributos: Record<string, any> = { pd_interactivo: estructura };

      if (messageType === 'outgoing') atributos.external_echo = true;

      data.append('content', texto ?? '');
      data.append('message_type', messageType);
      data.append('content_attributes', JSON.stringify(atributos));
      data.append('source_id', 'WAID:' + body.key.id);

      const respuesta = await axios.post(
        `${this.provider.url}/api/v1/accounts/${this.provider.accountId}/conversations/${conversationId}/messages`,
        data,
        {
          maxBodyLength: Infinity,
          headers: { api_access_token: this.provider.token, ...data.getHeaders() },
        },
      );

      this.logger.info(`[PD] interactivo enviado a Chatwoot con ${subidas} imagen(es)`);

      return respuesta?.data ?? true;
    } catch (error) {
      this.logger.error(`[PD] no se pudo enviar el interactivo con imágenes: ${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * PD: el catálogo. Cada tarjeta lleva su foto dentro de `header.imageMessage`.
   */
  private async enviarCarrusel(
    instance: InstanceDto,
    waInstance: any,
    conversationId: number,
    messageType: 'incoming' | 'outgoing',
    body: any,
  ): Promise<any> {
    const estructura = this.estructuraDeCarrusel(body.message.interactiveMessage);

    if (!estructura) return false;

    const tarjetas = body.message.interactiveMessage.carouselMessage.cards ?? [];

    const imagenes = tarjetas.map((tarjeta: any, posicion: number) => ({
      imagen: tarjeta?.header?.imageMessage,
      anotar: (indice: number) => {
        estructura.tarjetas[posicion].adjunto = indice;
      },
    }));

    return this.enviarInteractivoConImagenes(
      instance,
      waInstance,
      conversationId,
      messageType,
      body,
      estructura,
      imagenes,
      this.aMarkdownDeChatwoot(this.textoDeCarrusel(estructura)) ?? '',
    );
  }

  /**
   * PD: unos botones con logo de cabecera —lo que se manda como `thumbnailUrl`—. Es lo que sirve en
   * LATAM para un pago: el PIX es de Brasil, lo dibuja WhatsApp y **no admite imagen**, así que un
   * cobro por transferencia, Pago Móvil o Binance se arma con `cta_copy` y su logo.
   */
  private async enviarBotonesConLogo(
    instance: InstanceDto,
    waInstance: any,
    conversationId: number,
    messageType: 'incoming' | 'outgoing',
    body: any,
    texto: string,
  ): Promise<any> {
    const nodo = body.message.interactiveMessage;
    const estructura = this.estructuraDeBotones(nodo);

    if (!estructura?.conImagen) return false;

    return this.enviarInteractivoConImagenes(
      instance,
      waInstance,
      conversationId,
      messageType,
      body,
      estructura,
      [{ imagen: nodo.header.imageMessage, anotar: (indice: number) => (estructura.adjunto = indice) }],
      texto,
    );
  }

  /**
   * PD: el texto de respaldo de un catálogo, para el correo de notificación, el buscador y
   * cualquier cliente que no pinte la tarjeta.
   */
  private textoDeCarrusel(estructura: Record<string, any>): string {
    const lineas: string[] = [];

    if (estructura.cuerpo) lineas.push(`*${estructura.cuerpo}*`);

    for (const tarjeta of estructura.tarjetas ?? []) {
      const partes = [tarjeta.cuerpo, tarjeta.pie].filter(Boolean).join(' — ');

      if (partes) lineas.push(`▪️ ${partes}`);
    }

    if (estructura.pie) lineas.push(`_${estructura.pie}_`);

    return lineas.join('\n');
  }

  private async sendData(
    conversationId: number,
    fileStream: Readable,
    fileName: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    content?: string,
    instance?: InstanceDto,
    messageBody?: any,
    sourceId?: string,
    quotedMsg?: MessageModel,
  ) {
    if (sourceId && this.isImportHistoryAvailable()) {
      const messageAlreadySaved = await chatwootImport.getExistingSourceIds([sourceId], conversationId);
      if (messageAlreadySaved) {
        if (messageAlreadySaved.size > 0) {
          this.logger.warn('Message already saved on chatwoot');
          return null;
        }
      }
    }
    const data = new FormData();

    if (content) {
      data.append('content', content);
    }

    data.append('message_type', messageType);

    data.append('attachments[]', fileStream, { filename: fileName });

    const sourceReplyId = quotedMsg?.chatwootMessageId || null;

    if (messageBody && instance) {
      const replyToIds = await this.getReplyToIds(messageBody, instance);

      // Filtra valores null/undefined antes de enviar
      const filteredReplyToIds = Object.fromEntries(Object.entries(replyToIds).filter(([, value]) => value != null));

      if (Object.keys(filteredReplyToIds).length > 0) {
        const contentAttrs = JSON.stringify(filteredReplyToIds);
        data.append('content_attributes', contentAttrs);
      }
    }

    if (sourceReplyId) {
      data.append('source_reply_id', sourceReplyId.toString());
    }

    if (sourceId) {
      data.append('source_id', sourceId);
    }

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `${this.provider.url}/api/v1/accounts/${this.provider.accountId}/conversations/${conversationId}/messages`,
      headers: {
        api_access_token: this.provider.token,
        ...data.getHeaders(),
      },
      data: data,
    };

    try {
      const { data } = await axios.request(config);

      return data;
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async createBotQr(
    instance: InstanceDto,
    content: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    fileStream?: Readable,
    fileName?: string,
  ) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    if (!this.configService.get<Chatwoot>('CHATWOOT').BOT_CONTACT) {
      this.logger.log('Chatwoot bot contact is disabled');

      return true;
    }

    const contact = await this.findContact(instance, '123456');

    if (!contact) {
      this.logger.warn('contact not found');
      return null;
    }

    const filterInbox = await this.getInbox(instance);

    if (!filterInbox) {
      this.logger.warn('inbox not found');
      return null;
    }

    const conversation = await this.getOpenConversationByContact(instance, filterInbox, contact);

    if (!conversation) {
      this.logger.warn('conversation not found');
      return;
    }

    const data = new FormData();

    if (content) {
      data.append('content', content);
    }

    data.append('message_type', messageType);

    if (fileStream && fileName) {
      data.append('attachments[]', fileStream, { filename: fileName });
    }

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `${this.provider.url}/api/v1/accounts/${this.provider.accountId}/conversations/${conversation.id}/messages`,
      headers: {
        api_access_token: this.provider.token,
        ...data.getHeaders(),
      },
      data: data,
    };

    try {
      const { data } = await axios.request(config);

      return data;
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async sendAttachment(waInstance: any, number: string, media: any, caption?: string, options?: Options) {
    try {
      const parsedMedia = path.parse(decodeURIComponent(media));
      let mimeType = mimeTypes.lookup(parsedMedia?.ext) || '';
      let fileName = parsedMedia?.name + parsedMedia?.ext;

      if (!mimeType) {
        const parts = media.split('/');
        fileName = decodeURIComponent(parts[parts.length - 1]);

        const response = await axios.get(media, {
          responseType: 'arraybuffer',
        });
        mimeType = String(response.headers['content-type']);
      }

      let type = 'document';

      switch (mimeType.split('/')[0]) {
        case 'image':
          type = 'image';
          break;
        case 'video':
          type = 'video';
          break;
        case 'audio':
          type = 'audio';
          break;
        default:
          type = 'document';
          break;
      }

      if (type === 'audio') {
        const data: SendAudioDto = {
          number: number,
          audio: media,
          delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500,
          quoted: options?.quoted,
        };

        sendTelemetry('/message/sendWhatsAppAudio');

        const messageSent = await waInstance?.audioWhatsapp(data, null, true);

        return messageSent;
      }

      const documentExtensions = ['.gif', '.svg', '.tiff', '.tif', '.dxf', '.dwg'];
      if (type === 'image' && parsedMedia && documentExtensions.includes(parsedMedia?.ext)) {
        type = 'document';
      }

      const data: SendMediaDto = {
        number: number,
        mediatype: type as any,
        fileName: fileName,
        media: media,
        delay: 1200,
        quoted: options?.quoted,
      };

      sendTelemetry('/message/sendMedia');

      if (caption) {
        data.caption = caption;
      }

      const messageSent = await waInstance?.mediaMessage(data, null, true);

      return messageSent;
    } catch (error) {
      this.logger.error(error);
      throw error; // Re-throw para que o erro seja tratado pelo caller
    }
  }

  public async onSendMessageError(instance: InstanceDto, conversation: number, error?: any) {
    this.logger.verbose(`onSendMessageError ${JSON.stringify(error)}`);

    const client = await this.clientCw(instance);

    if (!client) {
      return;
    }

    if (error && error?.status === 400 && error?.message[0]?.exists === false) {
      client.messages.create({
        accountId: this.provider.accountId,
        conversationId: conversation,
        data: {
          content: `${i18next.t('cw.message.numbernotinwhatsapp')}`,
          message_type: 'outgoing',
          private: true,
        },
      });

      return;
    }

    client.messages.create({
      accountId: this.provider.accountId,
      conversationId: conversation,
      data: {
        content: i18next.t('cw.message.notsent', {
          error: error ? `_${error.toString()}_` : '',
        }),
        message_type: 'outgoing',
        private: true,
      },
    });
  }

  public async receiveWebhook(instance: InstanceDto, body: any) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));

      const client = await this.clientCw(instance);

      if (!client) {
        this.logger.warn('client not found');
        return null;
      }

      if (
        this.provider.reopenConversation === false &&
        body.event === 'conversation_status_changed' &&
        body.status === 'resolved' &&
        body.meta?.sender?.identifier
      ) {
        const keyToDelete = `${instance.instanceName}:createConversation-${body.meta.sender.identifier}`;
        this.cache.delete(keyToDelete);
      }

      if (
        !body?.conversation ||
        body.private ||
        (body.event === 'message_updated' && !body.content_attributes?.deleted)
      ) {
        return { message: 'bot' };
      }

      const chatId =
        body.conversation.meta.sender?.identifier || body.conversation.meta.sender?.phone_number.replace('+', '');
      // Chatwoot to Whatsapp
      const messageReceived = body.content
        ? body.content
            .replaceAll(/(?<!\*)\*((?!\s)([^\n*]+?)(?<!\s))\*(?!\*)/g, '_$1_') // Substitui * por _
            .replaceAll(/\*{2}((?!\s)([^\n*]+?)(?<!\s))\*{2}/g, '*$1*') // Substitui ** por *
            .replaceAll(/~{2}((?!\s)([^\n*]+?)(?<!\s))~{2}/g, '~$1~') // Substitui ~~ por ~
            .replaceAll(/(?<!`)`((?!\s)([^`*]+?)(?<!\s))`(?!`)/g, '```$1```') // Substitui ` por ```
        : body.content;

      const senderName = body?.conversation?.messages[0]?.sender?.available_name || body?.sender?.name;
      const waInstance = this.waMonitor.waInstances[instance.instanceName];
      instance.instanceId = waInstance.instanceId;

      if (body.event === 'message_updated' && body.content_attributes?.deleted) {
        const message = await this.prismaRepository.message.findFirst({
          where: {
            chatwootMessageId: body.id,
            instanceId: instance.instanceId,
          },
        });

        if (message) {
          const key = message.key as WAMessageKey;

          await waInstance?.client.sendMessage(key.remoteJid, { delete: key });

          await this.prismaRepository.message.deleteMany({
            where: {
              instanceId: instance.instanceId,
              chatwootMessageId: body.id,
            },
          });
        }
        return { message: 'bot' };
      }

      const cwBotContact = this.configService.get<Chatwoot>('CHATWOOT').BOT_CONTACT;

      if (chatId === '123456' && body.message_type === 'outgoing') {
        const command = messageReceived.replace('/', '');

        if (cwBotContact && (command.includes('init') || command.includes('iniciar'))) {
          const state = waInstance?.connectionStatus?.state;

          if (state !== 'open') {
            const number = command.split(':')[1];
            await waInstance.connectToWhatsapp(number);
          } else {
            await this.createBotMessage(
              instance,
              i18next.t('cw.inbox.alreadyConnected', {
                inboxName: body.inbox.name,
              }),
              'incoming',
            );
          }
        }

        if (command === 'clearcache') {
          waInstance.clearCacheChatwoot();
          await this.createBotMessage(
            instance,
            i18next.t('cw.inbox.clearCache', {
              inboxName: body.inbox.name,
            }),
            'incoming',
          );
        }

        if (command === 'status') {
          const state = waInstance?.connectionStatus?.state;

          if (!state) {
            await this.createBotMessage(
              instance,
              i18next.t('cw.inbox.notFound', {
                inboxName: body.inbox.name,
              }),
              'incoming',
            );
          }

          if (state) {
            await this.createBotMessage(
              instance,
              i18next.t('cw.inbox.status', {
                inboxName: body.inbox.name,
                state: state,
              }),
              'incoming',
            );
          }
        }

        if (cwBotContact && (command === 'disconnect' || command === 'desconectar')) {
          const msgLogout = i18next.t('cw.inbox.disconnect', {
            inboxName: body.inbox.name,
          });

          await this.createBotMessage(instance, msgLogout, 'incoming');

          await waInstance?.client?.logout('Log out instance: ' + instance.instanceName);
          await waInstance?.client?.ws?.close();
        }
      }

      if (body.message_type === 'outgoing' && body?.conversation?.messages?.length && chatId !== '123456') {
        if (body?.conversation?.messages[0]?.source_id?.substring(0, 5) === 'WAID:') {
          return { message: 'bot' };
        }

        if (!waInstance && body.conversation?.id) {
          this.onSendMessageError(instance, body.conversation?.id, 'Instance not found');
          return { message: 'bot' };
        }

        let formatText: string;
        if (senderName === null || senderName === undefined) {
          formatText = messageReceived;
        } else {
          const formattedDelimiter = this.provider.signDelimiter
            ? this.provider.signDelimiter.replaceAll('\\n', '\n')
            : '\n';
          const textToConcat = this.provider.signMsg ? [`*${senderName}:*`] : [];
          textToConcat.push(messageReceived);

          formatText = textToConcat.join(formattedDelimiter);
        }

        for (const message of body.conversation.messages) {
          if (message.attachments && message.attachments.length > 0) {
            for (const attachment of message.attachments) {
              if (!messageReceived) {
                formatText = null;
              }

              const options: Options = {
                quoted: await this.getQuotedMessage(body, instance),
              };

              const messageSent = await this.sendAttachment(
                waInstance,
                chatId,
                attachment.data_url,
                formatText,
                options,
              );
              if (!messageSent && body.conversation?.id) {
                this.onSendMessageError(instance, body.conversation?.id);
              }

              await this.updateChatwootMessageId(
                {
                  ...messageSent,
                },
                {
                  messageId: body.id,
                  inboxId: body.inbox?.id,
                  conversationId: body.conversation?.id,
                  contactInboxSourceId: body.conversation?.contact_inbox?.source_id,
                },
                instance,
              );
            }
          } else {
            // PD: si el agente eligió una PLANTILLA en el selector de Chatwoot, el webhook trae
            // `additional_attributes.template_params`. Sin esto se enviaba el texto ya renderizado
            // como mensaje normal: llegaba plano —sin encabezado, sin pie y sin botones— y, fuera de
            // la ventana de 24 h, no llegaba en absoluto, porque Meta solo acepta plantillas ahí.
            const plantilla = this.datosDePlantilla(body);

            if (plantilla && waInstance?.integration === Integration.WHATSAPP_BUSINESS) {
              const enviada = await this.enviarComoPlantilla(waInstance, chatId, plantilla, instance, body);
              if (enviada) return;
              // Si falla, sigue el camino de texto: dentro de la ventana al menos llega algo.
            }

            const data: SendTextDto = {
              number: chatId,
              text: formatText,
              delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500,
              quoted: await this.getQuotedMessage(body, instance),
            };

            sendTelemetry('/message/sendText');

            let messageSent: any;
            try {
              messageSent = await waInstance?.textMessage(data, true);
              if (!messageSent) {
                throw new Error('Message not sent');
              }

              if (Long.isLong(messageSent?.messageTimestamp)) {
                messageSent.messageTimestamp = messageSent.messageTimestamp?.toNumber();
              }

              await this.updateChatwootMessageId(
                {
                  ...messageSent,
                },
                {
                  messageId: body.id,
                  inboxId: body.inbox?.id,
                  conversationId: body.conversation?.id,
                  contactInboxSourceId: body.conversation?.contact_inbox?.source_id,
                },
                instance,
              );
            } catch (error) {
              if (!messageSent && body.conversation?.id) {
                this.onSendMessageError(instance, body.conversation?.id, error);
              }
              throw error;
            }
          }
        }

        const chatwootRead = this.configService.get<Chatwoot>('CHATWOOT').MESSAGE_READ;
        if (chatwootRead) {
          const lastMessage = await this.prismaRepository.message.findFirst({
            where: {
              key: {
                path: ['fromMe'],
                equals: false,
              },
              instanceId: instance.instanceId,
            },
          });
          if (lastMessage && !lastMessage.chatwootIsRead) {
            const key = lastMessage.key as WAMessageKey;

            waInstance?.markMessageAsRead({
              readMessages: [
                {
                  id: key.id,
                  fromMe: key.fromMe,
                  remoteJid: key.remoteJid,
                },
              ],
            });
            const updateMessage = {
              chatwootMessageId: lastMessage.chatwootMessageId,
              chatwootConversationId: lastMessage.chatwootConversationId,
              chatwootInboxId: lastMessage.chatwootInboxId,
              chatwootContactInboxSourceId: lastMessage.chatwootContactInboxSourceId,
              chatwootIsRead: true,
            };

            await this.prismaRepository.message.updateMany({
              where: {
                instanceId: instance.instanceId,
                key: {
                  path: ['id'],
                  equals: key.id,
                },
              },
              data: updateMessage,
            });
          }
        }
      }

      if (body.message_type === 'template' && body.event === 'message_created') {
        const data: SendTextDto = {
          number: chatId,
          text: body.content.replace(/\\\r\n|\\\n|\n/g, '\n'),
          delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500,
        };

        sendTelemetry('/message/sendText');

        await waInstance?.textMessage(data);
      }

      return { message: 'bot' };
    } catch (error) {
      this.logger.error(error);

      return { message: 'bot' };
    }
  }

  private async updateChatwootMessageId(
    message: MessageModel,
    chatwootMessageIds: ChatwootMessage,
    instance: InstanceDto,
  ) {
    const key = message.key as WAMessageKey;

    if (!chatwootMessageIds.messageId || !key?.id) {
      return;
    }

    const provider = this.configService.get<Database>('DATABASE').PROVIDER;
    let result: number;

    if (provider === 'mysql') {
      // MySQL version
      result = await this.prismaRepository.$executeRaw`
        UPDATE Message
        SET
          chatwootMessageId = ${chatwootMessageIds.messageId},
          chatwootConversationId = ${chatwootMessageIds.conversationId},
          chatwootInboxId = ${chatwootMessageIds.inboxId},
          chatwootContactInboxSourceId = ${chatwootMessageIds.contactInboxSourceId},
          chatwootIsRead = ${chatwootMessageIds.isRead || false}
        WHERE instanceId = ${instance.instanceId}
        AND JSON_UNQUOTE(JSON_EXTRACT(\`key\`, '$.id')) = ${key.id}
      `;
    } else {
      // PostgreSQL version
      result = await this.prismaRepository.$executeRaw`
        UPDATE "Message"
        SET
          "chatwootMessageId" = ${chatwootMessageIds.messageId},
          "chatwootConversationId" = ${chatwootMessageIds.conversationId},
          "chatwootInboxId" = ${chatwootMessageIds.inboxId},
          "chatwootContactInboxSourceId" = ${chatwootMessageIds.contactInboxSourceId},
          "chatwootIsRead" = ${chatwootMessageIds.isRead || false}
        WHERE "instanceId" = ${instance.instanceId}
        AND "key"->>'id' = ${key.id}
      `;
    }

    this.logger.verbose(`Update result: ${result} rows affected`);

    if (this.isImportHistoryAvailable()) {
      try {
        await chatwootImport.updateMessageSourceID(chatwootMessageIds.messageId, key.id);
      } catch (error) {
        this.logger.error(`Error updating Chatwoot message source ID: ${error}`);
      }
    }
  }

  private async getMessageByKeyId(instance: InstanceDto, keyId: string): Promise<MessageModel> {
    const provider = this.configService.get<Database>('DATABASE').PROVIDER;
    let messages: MessageModel[];

    if (provider === 'mysql') {
      // MySQL version
      messages = await this.prismaRepository.$queryRaw`
        SELECT * FROM Message
        WHERE instanceId = ${instance.instanceId}
        AND JSON_UNQUOTE(JSON_EXTRACT(\`key\`, '$.id')) = ${keyId}
        LIMIT 1
      `;
    } else {
      // PostgreSQL version
      messages = await this.prismaRepository.$queryRaw`
        SELECT * FROM "Message"
        WHERE "instanceId" = ${instance.instanceId}
        AND "key"->>'id' = ${keyId}
        LIMIT 1
      `;
    }

    return messages[0] || null;
  }

  private async getReplyToIds(
    msg: any,
    instance: InstanceDto,
  ): Promise<{ in_reply_to: string; in_reply_to_external_id: string }> {
    let inReplyTo = null;
    let inReplyToExternalId = null;

    if (msg) {
      inReplyToExternalId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? msg.contextInfo?.stanzaId;
      if (inReplyToExternalId) {
        const message = await this.getMessageByKeyId(instance, inReplyToExternalId);
        if (message?.chatwootMessageId) {
          inReplyTo = message.chatwootMessageId;
        }
      }
    }

    return {
      in_reply_to: inReplyTo,
      in_reply_to_external_id: inReplyToExternalId,
    };
  }

  private async getQuotedMessage(msg: any, instance: InstanceDto): Promise<Quoted> {
    if (msg?.content_attributes?.in_reply_to) {
      const message = await this.prismaRepository.message.findFirst({
        where: {
          chatwootMessageId: msg?.content_attributes?.in_reply_to,
          instanceId: instance.instanceId,
        },
      });

      const key = message?.key as WAMessageKey;
      const messageContent = message?.message as WAMessageContent;

      if (messageContent && key?.id) {
        return {
          key: key,
          message: messageContent,
        };
      }
    }

    return null;
  }

  private isMediaMessage(message: any) {
    const media = [
      'imageMessage',
      'documentMessage',
      'documentWithCaptionMessage',
      'audioMessage',
      'videoMessage',
      'stickerMessage',
      'viewOnceMessageV2',
    ];

    const messageKeys = Object.keys(message);

    const result = messageKeys.some((key) => media.includes(key));

    return result;
  }

  private isInteractiveButtonMessage(messageType: string, message: any) {
    return messageType === 'interactiveMessage' && message.interactiveMessage?.nativeFlowMessage?.buttons?.length > 0;
  }

  private getAdsMessage(msg: any) {
    interface AdsMessage {
      title: string;
      body: string;
      thumbnailUrl: string;
      sourceUrl: string;
    }

    const adsMessage: AdsMessage | undefined = {
      title: msg.extendedTextMessage?.contextInfo?.externalAdReply?.title || msg.contextInfo?.externalAdReply?.title,
      body: msg.extendedTextMessage?.contextInfo?.externalAdReply?.body || msg.contextInfo?.externalAdReply?.body,
      thumbnailUrl:
        msg.extendedTextMessage?.contextInfo?.externalAdReply?.thumbnailUrl ||
        msg.contextInfo?.externalAdReply?.thumbnailUrl,
      sourceUrl:
        msg.extendedTextMessage?.contextInfo?.externalAdReply?.sourceUrl || msg.contextInfo?.externalAdReply?.sourceUrl,
    };

    return adsMessage;
  }

  private getReactionMessage(msg: any) {
    interface ReactionMessage {
      key: {
        id: string;
        fromMe: boolean;
        remoteJid: string;
        participant?: string;
      };
      text: string;
    }
    const reactionMessage: ReactionMessage | undefined = msg?.reactionMessage;

    return reactionMessage;
  }

  private getTypeMessage(msg: any) {
    const types = {
      conversation: msg.conversation,
      imageMessage: msg.imageMessage?.caption,
      videoMessage: msg.videoMessage?.caption,
      extendedTextMessage: msg.extendedTextMessage?.text,
      messageContextInfo: msg.messageContextInfo?.stanzaId,
      stickerMessage: undefined,
      documentMessage: msg.documentMessage?.caption,
      documentWithCaptionMessage: msg.documentWithCaptionMessage?.message?.documentMessage?.caption,
      audioMessage: msg.audioMessage ? (msg.audioMessage.caption ?? '') : undefined,
      contactMessage: msg.contactMessage?.vcard,
      contactsArrayMessage: msg.contactsArrayMessage,
      locationMessage: msg.locationMessage,
      liveLocationMessage: msg.liveLocationMessage,
      listMessage: msg.listMessage,
      listResponseMessage: msg.listResponseMessage,
      orderMessage: msg.orderMessage,
      quotedProductMessage: msg.contextInfo?.quotedMessage?.productMessage,
      viewOnceMessageV2:
        msg?.message?.viewOnceMessageV2?.message?.imageMessage?.url ||
        msg?.message?.viewOnceMessageV2?.message?.videoMessage?.url ||
        msg?.message?.viewOnceMessageV2?.message?.audioMessage?.url,
      // PD: una plantilla de la Cloud API llega sin campo de texto plano, así que Chatwoot la
      // descartaba con «no body message found» y la conversación no mostraba nada.
      templateMessage: this.getTemplateText(msg.templateMessage),
      // PD: y la respuesta del usuario a un botón tampoco tiene texto plano en Baileys.
      templateButtonReplyMessage: msg.templateButtonReplyMessage?.selectedDisplayText,
      buttonsResponseMessage:
        msg.buttonsResponseMessage?.selectedDisplayText ?? msg.buttonsResponseMessage?.selectedButtonId,
      interactiveResponseMessage: this.getInteractiveResponseText(msg.interactiveResponseMessage),
      // PD: los botones que manda Evolution con `sendButtons` van aquí, sin texto plano.
      interactiveMessage: this.textoDeInteractivo(msg.interactiveMessage),
      buttonsMessage: msg.buttonsMessage?.contentText,
    };

    return types;
  }

  /**
   * PD: arma el texto de una plantilla para que se vea en Chatwoot.
   * Cubre las dos formas en que llega: `interactiveMessageTemplate` (lo que emite la Cloud API en
   * coexistencia) y las `hydratedTemplate` clásicas de Baileys.
   */
  private getTemplateText(templateMessage: any): string | undefined {
    if (!templateMessage) return undefined;

    const texto = this.textoDeInteractivo(templateMessage.interactiveMessageTemplate);
    if (texto) return texto;

    const hidratada = templateMessage.hydratedTemplate ?? templateMessage.hydratedFourRowTemplate;
    if (hidratada?.hydratedContentText) return hidratada.hydratedContentText;

    // Última red: que se vea que hubo una plantilla, aunque no se pueda leer su texto.
    return templateMessage.templateId ? `▶️ plantilla ${templateMessage.templateId}` : undefined;
  }

  /**
   * PD: arma el texto legible de un nodo interactivo —`interactiveMessage` (los botones que manda
   * Evolution con `sendButtons`) o `interactiveMessageTemplate` (una plantilla de la Cloud API)—.
   * Los dos tienen la misma forma: header, body, footer y los botones en `nativeFlowMessage`.
   */
  public textoDeInteractivo(nodo: any): string | undefined {
    if (!nodo) return undefined;

    const partes: string[] = [];
    const botones: string[] = [];

    const titulo = nodo.header?.title ?? nodo.header?.text;
    if (titulo) partes.push(`*${titulo}*`);
    if (nodo.body?.text) partes.push(nodo.body.text);
    if (nodo.footer?.text) partes.push(`_${nodo.footer.text}_`);

    for (const boton of nodo.nativeFlowMessage?.buttons ?? []) {
      let etiqueta = boton?.name;
      try {
        const params = JSON.parse(boton?.buttonParamsJson ?? '{}');
        etiqueta = params.display_text ?? params.title ?? etiqueta;
      } catch {
        // buttonParamsJson viene como cadena y puede no ser JSON válido: se deja el nombre.
      }
      // Se escribe en formato de WhatsApp (`*negrita*`): `aMarkdownDeChatwoot` lo traduce después.
      // La línea de guiones es el separador que WhatsApp dibuja entre las opciones.
      if (etiqueta) botones.push(`↩ *${etiqueta}*`);
    }

    const cuerpo = partes.join('\n\n');
    const opciones = botones.length ? `\n\n---\n${botones.join('\n')}` : '';

    return cuerpo || opciones ? `${cuerpo}${opciones}` : undefined;
  }

  /**
   * PD: la etiqueta de un botón no es texto suelto: vive dentro de `buttonParamsJson`, que es una
   * CADENA JSON dentro del propio botón. Se parsea con try/catch porque no siempre es válida.
   */
  private parametrosDeBoton(boton: any): Record<string, any> {
    try {
      return JSON.parse(boton?.buttonParamsJson ?? '{}');
    } catch {
      return {};
    }
  }

  /**
   * PD: normaliza los botones de un `nativeFlowMessage` a la forma que pinta Chatwoot.
   *
   * `name` dice de qué clase es cada uno, y cada clase guarda su dato en una llave distinta:
   * `cta_url` lleva `url`, `cta_copy` lleva `copy_code`, `cta_call` lleva `phone_number` y
   * `quick_reply` solo lleva su `id`, porque lo único que hace es contestar.
   */
  private botonesNormalizados(nodo: any): Array<Record<string, any>> {
    const botones: Array<Record<string, any>> = [];

    for (const boton of nodo?.nativeFlowMessage?.buttons ?? []) {
      const params = this.parametrosDeBoton(boton);
      const texto = params.display_text ?? params.title ?? boton?.name;

      if (!texto) continue;

      const clase =
        {
          cta_url: 'url',
          cta_copy: 'copiar',
          cta_call: 'llamar',
          quick_reply: 'respuesta',
        }[boton?.name as string] ?? 'respuesta';

      botones.push({
        clase,
        texto,
        ...(params.url ? { url: params.url } : {}),
        ...(params.copy_code ? { codigo: params.copy_code } : {}),
        ...(params.phone_number ? { telefono: params.phone_number } : {}),
        ...(params.id ? { id: params.id } : {}),
      });
    }

    return botones;
  }

  /**
   * PD: el PIX no es un botón normal. Viene como un `payment_info` cuyo `buttonParamsJson` trae
   * `payment_settings[0].pix_static_code` con el comercio y la clave. En WhatsApp se ve como una
   * tarjeta con su botón «Copiar clave Pix».
   */
  private estructuraDePix(nodo: any): Record<string, any> | undefined {
    for (const boton of nodo?.nativeFlowMessage?.buttons ?? []) {
      if (boton?.name !== 'payment_info') continue;

      const ajustes = this.parametrosDeBoton(boton)?.payment_settings?.[0];
      const pix = ajustes?.pix_static_code;

      if (ajustes?.type !== 'pix_static_code' || !pix) continue;

      const tipoClave =
        { EVP: 'Chave Aleatória', EMAIL: 'E-mail', PHONE: 'Telefone' }[pix.key_type as string] ?? pix.key_type;

      return {
        clase: 'pix',
        comercio: pix.merchant_name,
        clave: pix.key_type === 'PHONE' ? String(pix.key).replace('+55', '') : pix.key,
        tipoClave,
      };
    }

    return undefined;
  }

  /**
   * PD: un carrusel (el catálogo) son varias tarjetas, cada una con su imagen, su texto, su pie y
   * sus botones. La imagen NO viaja aquí: las de WhatsApp van cifradas y se descargan aparte, así
   * que cada tarjeta guarda su posición y Chatwoot la casa con el adjunto que le toca.
   */
  private estructuraDeCarrusel(nodo: any): Record<string, any> | undefined {
    const tarjetas = nodo?.carouselMessage?.cards;

    if (!tarjetas?.length) return undefined;

    return {
      clase: 'carrusel',
      cuerpo: nodo?.body?.text,
      pie: nodo?.footer?.text,
      tarjetas: tarjetas.map((tarjeta: any, posicion: number) => ({
        posicion,
        titulo: tarjeta?.header?.title ?? tarjeta?.header?.text,
        cuerpo: tarjeta?.body?.text,
        pie: tarjeta?.footer?.text,
        conImagen: !!tarjeta?.header?.imageMessage,
        botones: this.botonesNormalizados(tarjeta),
      })),
    };
  }

  /**
   * PD: un menú de lista NO se enseña abierto. En WhatsApp es UN botón («Ver opciones») que abre
   * las secciones en un panel, y así tiene que verse en la bandeja: upstream lo volcaba entero en
   * crudo —«Section 1: / Line 1: / Title: / Description: / ID:», en inglés— y en un menú de tres
   * servicios eso son catorce líneas ilegibles.
   */
  private estructuraDeLista(lista: any): Record<string, any> | undefined {
    if (!lista) return undefined;

    return {
      clase: 'lista',
      encabezado: lista.title,
      cuerpo: lista.description,
      pie: lista.footerText,
      textoBoton: lista.buttonText || 'Ver opciones',
      secciones: (lista.sections ?? []).map((seccion: any) => ({
        titulo: seccion?.title,
        filas: (seccion?.rows ?? []).map((fila: any) => ({
          titulo: fila?.title,
          descripcion: fila?.description,
          id: fila?.rowId,
        })),
      })),
    };
  }

  /**
   * PD: lo que eligió la persona, ya sea de una lista o de un botón. Se pinta distinto de un
   * mensaje suelto: es una respuesta a algo que le enseñamos.
   */
  private estructuraDeRespuesta(mensaje: any): Record<string, any> | undefined {
    const deLista = mensaje?.listResponseMessage;

    if (deLista) {
      return {
        clase: 'respuesta',
        titulo: deLista.title,
        descripcion: deLista.description,
        id: deLista.singleSelectReply?.selectedRowId,
      };
    }

    const deBoton = mensaje?.templateButtonReplyMessage ?? mensaje?.buttonsResponseMessage;

    if (deBoton) {
      return {
        clase: 'respuesta',
        titulo: deBoton.selectedDisplayText ?? deBoton.selectedButtonId,
        id: deBoton.selectedId ?? deBoton.selectedButtonId,
      };
    }

    return undefined;
  }

  /**
   * PD: el interactivo genérico —los botones de respuesta rápida y los CTA—. El encabezado puede
   * venir en `header` o, como hace el propio Evolution al mandarlos, en negrita dentro del cuerpo:
   * eso se deja tal cual, que el cuerpo se pinta con su formato.
   */
  private estructuraDeBotones(nodo: any): Record<string, any> | undefined {
    if (!nodo) return undefined;

    const botones = this.botonesNormalizados(nodo);
    const encabezado = nodo.header?.title ?? nodo.header?.text;
    const cuerpo = nodo.body?.text;
    const pie = nodo.footer?.text;

    if (!botones.length && !encabezado && !pie) return undefined;

    // 🔴 El cuerpo va traducido al formato de Chatwoot, porque lo pinta el mismo renderizador de
    // markdown que el resto: en WhatsApp `*x*` es negrita y en markdown-it es CURSIVA.
    return {
      clase: 'botones',
      encabezado,
      cuerpo: this.aMarkdownDeChatwoot(cuerpo),
      pie,
      botones,
      // El `thumbnailUrl` del envío llega aquí como imagen de cabecera. NO cuenta como «mensaje con
      // medio» —`isMediaMessage` solo mira las claves de primer nivel—, así que sin subirla aparte
      // el logo se queda en el teléfono.
      conImagen: !!nodo.header?.imageMessage,
    };
  }

  /**
   * PD: el despachador. Mira el mensaje de WhatsApp y devuelve la estructura que Chatwoot sabe
   * pintar, o `undefined` si es un mensaje corriente.
   *
   * 🔴 Esto NO sustituye al texto: el `content` del mensaje sigue siendo el de siempre. Si un día
   * se quita el componente del fork, o alguien lee el correo de notificación, ahí está todo.
   */
  public estructuraDeInteractivo(mensaje: any): Record<string, any> | undefined {
    if (!mensaje) return undefined;

    const nodo = mensaje.interactiveMessage ?? mensaje.templateMessage?.interactiveMessageTemplate;

    if (nodo) {
      return this.estructuraDePix(nodo) ?? this.estructuraDeCarrusel(nodo) ?? this.estructuraDeBotones(nodo);
    }

    return this.estructuraDeLista(mensaje.listMessage) ?? this.estructuraDeRespuesta(mensaje);
  }

  /**
   * PD: lee los `template_params` que Chatwoot mete en el mensaje cuando el agente usa el selector
   * de plantillas. Devuelve `undefined` si no era una plantilla.
   *
   * Chatwoot manda: `{ name, category, language, content_mode, processed_params }`.
   * `processed_params` son los valores que rellenó el agente, con la clave de cada variable:
   * `{"1": "Carlos"}` si la plantilla usa parámetros posicionales, `{"nombre": "Carlos"}` si usa
   * los que llevan nombre.
   */
  private datosDePlantilla(body: any): { name: string; language: string; params: Record<string, any> } | undefined {
    const params = body?.additional_attributes?.template_params;

    if (!params?.name) return undefined;

    return {
      name: params.name,
      language: params.language || 'es',
      params: params.processed_params || {},
    };
  }

  /**
   * PD: manda una plantilla de verdad por la Cloud API, en vez del texto renderizado. Devuelve
   * `true` si salió, para que quien llama no envíe además el texto.
   */
  private async enviarComoPlantilla(
    waInstance: any,
    chatId: string,
    plantilla: { name: string; language: string; params: Record<string, any> },
    instance: InstanceDto,
    body: any,
  ): Promise<boolean> {
    const valores = Object.entries(plantilla.params ?? {});

    // Una clave numérica es un parámetro posicional; cualquier otra, uno con nombre.
    const parameters = valores.map(([clave, valor]) =>
      /^\d+$/.test(clave)
        ? { type: 'text', text: String(valor) }
        : { type: 'text', parameter_name: clave, text: String(valor) },
    );

    const components = parameters.length ? [{ type: 'body', parameters }] : [];

    try {
      const messageSent = await waInstance.templateMessage(
        {
          number: chatId,
          name: plantilla.name,
          language: plantilla.language,
          components,
        },
        true,
      );

      if (!messageSent) throw new Error('Template not sent');

      this.logger.info(`[PD] plantilla enviada por la Cloud API: ${plantilla.name}`);

      await this.updateChatwootMessageId(
        { ...messageSent },
        {
          messageId: body.id,
          inboxId: body.inbox?.id,
          conversationId: body.conversation?.id,
          contactInboxSourceId: body.conversation?.contact_inbox?.source_id,
        },
        instance,
      );

      return true;
    } catch (error) {
      // No se traga el fallo: si la plantilla no sale, hay que verlo en el log.
      this.logger.error(`[PD] no se pudo enviar la plantilla ${plantilla.name}: ${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * PD: WhatsApp y Chatwoot escriben el formato distinto. WhatsApp usa `*negrita*`, `_cursiva_` y
   * `~tachado~`; Chatwoot lo pinta con **markdown-it**, donde `*x*` es CURSIVA y la negrita es
   * `**x**`. Sin esta traducción el título de un mensaje con botones salía en cursiva —o con los
   * asteriscos a la vista—, en vez de la negrita que se ve en el teléfono.
   *
   * Estaba escrito a mano dentro del flujo normal; ahora es un método, porque el camino de los
   * botones interactivos crea su propio mensaje y se lo saltaba.
   */
  private aMarkdownDeChatwoot(texto?: string): string | undefined {
    if (!texto) return texto;

    // `replace` con /g, no `replaceAll`: el `lib` de este proyecto es anterior a ES2021 y sobre un
    // `string` tipado el compilador lo rechaza (en el flujo original colaba porque era `any`).
    return texto
      .replace(/\*((?!\s)([^\n*]+?)(?<!\s))\*/g, '**$1**')
      .replace(/_((?!\s)([^\n_]+?)(?<!\s))_/g, '*$1*')
      .replace(/~((?!\s)([^\n~]+?)(?<!\s))~/g, '~~$1~~');
  }

  /** PD: respuesta del usuario a un botón de flujo nativo (nativeFlowResponseMessage). */
  private getInteractiveResponseText(interactiveResponseMessage: any): string | undefined {
    if (!interactiveResponseMessage) return undefined;

    const respuesta = interactiveResponseMessage.nativeFlowResponseMessage;
    if (respuesta?.paramsJson) {
      try {
        const params = JSON.parse(respuesta.paramsJson);
        const texto = params.display_text ?? params.title ?? params.id;
        if (texto) return texto;
      } catch {
        // igual que arriba: si no es JSON válido, se cae al nombre del flujo.
      }
    }

    return respuesta?.name ?? interactiveResponseMessage.body?.text;
  }

  private getMessageContent(types: any) {
    const typeKey = Object.keys(types).find((key) => types[key] !== undefined);

    let result = typeKey ? types[typeKey] : undefined;

    // Remove externalAdReplyBody| in Chatwoot
    if (result && typeof result === 'string' && result.includes('externalAdReplyBody|')) {
      result = result.split('externalAdReplyBody|').filter(Boolean).join('');
    }

    // Tratamento de Pedidos do Catálogo (WhatsApp Business Catalog)
    if (typeKey === 'orderMessage' && result.orderId) {
      const now = Date.now();
      // Limpa entradas antigas do cache
      this.processedOrderIds.forEach((timestamp, id) => {
        if (now - timestamp > this.ORDER_CACHE_TTL_MS) {
          this.processedOrderIds.delete(id);
        }
      });
      // Verifica se já processou este orderId
      if (this.processedOrderIds.has(result.orderId)) {
        return undefined; // Ignora duplicado
      }
      this.processedOrderIds.set(result.orderId, now);
    }
    // Tratamento de Produto citado (WhatsApp Desktop)
    if (typeKey === 'quotedProductMessage' && result?.product) {
      const product = result.product;

      // Extrai preço
      let rawPrice = 0;
      const amount = product.priceAmount1000;

      if (Long.isLong(amount)) {
        rawPrice = amount.toNumber();
      } else if (amount && typeof amount === 'object' && 'low' in amount) {
        rawPrice = Long.fromValue(amount).toNumber();
      } else if (typeof amount === 'number') {
        rawPrice = amount;
      }

      const price = (rawPrice / 1000).toLocaleString('pt-BR', {
        style: 'currency',
        currency: product.currencyCode || 'BRL',
      });

      const productTitle = product.title || 'Produto do catálogo';
      const productId = product.productId || 'N/A';

      return (
        `🛒 *PRODUTO DO CATÁLOGO (Desktop)*\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `📦 *Produto:* ${productTitle}\n` +
        `💰 *Preço:* ${price}\n` +
        `🆔 *Código:* ${productId}\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `_Cliente perguntou: "${types.conversation || 'Me envia este produto?'}"_`
      );
    }
    if (typeKey === 'orderMessage') {
      // Extrai o valor - pode ser Long, objeto {low, high}, ou número direto
      let rawPrice = 0;
      const amount = result.totalAmount1000;

      if (Long.isLong(amount)) {
        rawPrice = amount.toNumber();
      } else if (amount && typeof amount === 'object' && 'low' in amount) {
        // Formato {low: number, high: number, unsigned: boolean}
        rawPrice = Long.fromValue(amount).toNumber();
      } else if (typeof amount === 'number') {
        rawPrice = amount;
      }

      const price = (rawPrice / 1000).toLocaleString('pt-BR', {
        style: 'currency',
        currency: result.totalCurrencyCode || 'BRL',
      });

      const itemCount = result.itemCount || 1;
      const orderTitle = result.orderTitle || 'Produto do catálogo';
      const orderId = result.orderId || 'N/A';

      return (
        `🛒 *NOVO PEDIDO NO CATÁLOGO*\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `📦 *Produto:* ${orderTitle}\n` +
        `📊 *Quantidade:* ${itemCount}\n` +
        `💰 *Total:* ${price}\n` +
        `🆔 *Pedido:* #${orderId}\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `_Responda para atender este pedido!_`
      );
    }

    if (typeKey === 'locationMessage' || typeKey === 'liveLocationMessage') {
      const latitude = result.degreesLatitude;
      const longitude = result.degreesLongitude;

      const locationName = result?.name;
      const locationAddress = result?.address;

      const formattedLocation =
        `*${i18next.t('cw.locationMessage.location')}:*\n\n` +
        `_${i18next.t('cw.locationMessage.latitude')}:_ ${latitude} \n` +
        `_${i18next.t('cw.locationMessage.longitude')}:_ ${longitude} \n` +
        (locationName ? `_${i18next.t('cw.locationMessage.locationName')}:_ ${locationName}\n` : '') +
        (locationAddress ? `_${i18next.t('cw.locationMessage.locationAddress')}:_ ${locationAddress} \n` : '') +
        `_${i18next.t('cw.locationMessage.locationUrl')}:_ ` +
        `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;

      return formattedLocation;
    }

    if (typeKey === 'contactMessage') {
      const vCardData = result.split('\n');
      const contactInfo = {};

      vCardData.forEach((line) => {
        const [key, value] = line.split(':');
        if (key && value) {
          contactInfo[key] = value;
        }
      });

      let formattedContact =
        `*${i18next.t('cw.contactMessage.contact')}:*\n\n` +
        `_${i18next.t('cw.contactMessage.name')}:_ ${contactInfo['FN']}`;

      let numberCount = 1;
      Object.keys(contactInfo).forEach((key) => {
        if (key.startsWith('item') && key.includes('TEL')) {
          const phoneNumber = contactInfo[key];
          formattedContact += `\n_${i18next.t('cw.contactMessage.number')} (${numberCount}):_ ${phoneNumber}`;
          numberCount++;
        } else if (key.includes('TEL')) {
          const phoneNumber = contactInfo[key];
          formattedContact += `\n_${i18next.t('cw.contactMessage.number')} (${numberCount}):_ ${phoneNumber}`;
          numberCount++;
        }
      });

      return formattedContact;
    }

    if (typeKey === 'contactsArrayMessage') {
      const formattedContacts = result.contacts.map((contact) => {
        const vCardData = contact.vcard.split('\n');
        const contactInfo = {};

        vCardData.forEach((line) => {
          const [key, value] = line.split(':');
          if (key && value) {
            contactInfo[key] = value;
          }
        });

        let formattedContact = `*${i18next.t('cw.contactMessage.contact')}:*\n\n_${i18next.t(
          'cw.contactMessage.name',
        )}:_ ${contact.displayName}`;

        let numberCount = 1;
        Object.keys(contactInfo).forEach((key) => {
          if (key.startsWith('item') && key.includes('TEL')) {
            const phoneNumber = contactInfo[key];
            formattedContact += `\n_${i18next.t('cw.contactMessage.number')} (${numberCount}):_ ${phoneNumber}`;
            numberCount++;
          } else if (key.includes('TEL')) {
            const phoneNumber = contactInfo[key];
            formattedContact += `\n_${i18next.t('cw.contactMessage.number')} (${numberCount}):_ ${phoneNumber}`;
            numberCount++;
          }
        });

        return formattedContact;
      });

      const formattedContactsArray = formattedContacts.join('\n\n');

      return formattedContactsArray;
    }

    if (typeKey === 'listMessage') {
      const listTitle = result?.title || 'Unknown';
      const listDescription = result?.description || 'Unknown';
      const listFooter = result?.footerText || 'Unknown';

      let formattedList =
        '*List Menu:*\n\n' +
        '_Title_: ' +
        listTitle +
        '\n' +
        '_Description_: ' +
        listDescription +
        '\n' +
        '_Footer_: ' +
        listFooter;

      if (result.sections && result.sections.length > 0) {
        result.sections.forEach((section, sectionIndex) => {
          formattedList += '\n\n*Section ' + (sectionIndex + 1) + ':* ' + section.title || 'Unknown\n';

          if (section.rows && section.rows.length > 0) {
            section.rows.forEach((row, rowIndex) => {
              formattedList += '\n*Line ' + (rowIndex + 1) + ':*\n';
              formattedList += '_▪️ Title:_ ' + (row.title || 'Unknown') + '\n';
              formattedList += '_▪️ Description:_ ' + (row.description || 'Unknown') + '\n';
              formattedList += '_▪️ ID:_ ' + (row.rowId || 'Unknown') + '\n';
            });
          } else {
            formattedList += '\nNo lines found in this section.\n';
          }
        });
      } else {
        formattedList += '\nNo sections found.\n';
      }

      return formattedList;
    }

    if (typeKey === 'listResponseMessage') {
      const responseTitle = result?.title || 'Unknown';
      const responseDescription = result?.description || 'Unknown';
      const responseRowId = result?.singleSelectReply?.selectedRowId || 'Unknown';

      const formattedResponseList =
        '*List Response:*\n\n' +
        '_Title_: ' +
        responseTitle +
        '\n' +
        '_Description_: ' +
        responseDescription +
        '\n' +
        '_ID_: ' +
        responseRowId;
      return formattedResponseList;
    }

    return result;
  }

  public getConversationMessage(msg: any) {
    const types = this.getTypeMessage(msg);

    const messageContent = this.getMessageContent(types);

    return messageContent;
  }

  public async eventWhatsapp(event: string, instance: InstanceDto, body: any) {
    try {
      const waInstance = this.waMonitor.waInstances[instance.instanceName];

      if (!waInstance) {
        this.logger.warn('wa instance not found');
        return null;
      }

      const client = await this.clientCw(instance);

      if (!client) {
        this.logger.warn('client not found');
        return null;
      }

      if (this.provider?.ignoreJids && this.provider?.ignoreJids.length > 0) {
        const ignoreJids: any = this.provider?.ignoreJids;

        let ignoreGroups = false;
        let ignoreContacts = false;

        if (ignoreJids.includes('@g.us')) {
          ignoreGroups = true;
        }

        if (ignoreJids.includes('@s.whatsapp.net')) {
          ignoreContacts = true;
        }

        if (ignoreGroups && body?.key?.remoteJid.endsWith('@g.us')) {
          this.logger.warn('Ignoring message from group: ' + body?.key?.remoteJid);
          return;
        }

        if (ignoreContacts && body?.key?.remoteJid.endsWith('@s.whatsapp.net')) {
          this.logger.warn('Ignoring message from contact: ' + body?.key?.remoteJid);
          return;
        }

        if (ignoreJids.includes(body?.key?.remoteJid)) {
          this.logger.warn('Ignoring message from jid: ' + body?.key?.remoteJid);
          return;
        }
      }

      // CORREÇÃO LID: Resolve LID para número normal antes de processar evento
      if (body?.key?.remoteJid && body.key.remoteJid.includes('@lid') && !body.key.remoteJid.endsWith('@g.us')) {
        const originalJid = body.key.remoteJid;
        const resolvedPhone = await this.resolveLidToPhone(instance, body.key);

        if (resolvedPhone && resolvedPhone !== originalJid) {
          this.logger.verbose(`Event LID resolved: ${originalJid} → ${resolvedPhone}`);
          body.key.remoteJid = resolvedPhone;

          // Salva mapeamento se temos remoteJidAlt
          if (body.key.remoteJidAlt) {
            this.saveLidMapping(originalJid, body.key.remoteJidAlt);
          }
        } else if (body.key.remoteJidAlt && !body.key.remoteJidAlt.includes('@lid')) {
          // Se não resolveu mas tem remoteJidAlt válido, usa ele
          this.logger.verbose(`Using remoteJidAlt for event: ${originalJid} → ${body.key.remoteJidAlt}`);
          body.key.remoteJid = body.key.remoteJidAlt;
          this.saveLidMapping(originalJid, body.key.remoteJidAlt);
        } else {
          this.logger.warn(`Could not resolve LID for event, keeping original: ${originalJid}`);
        }
      }

      if (event === 'messages.upsert' || event === 'send.message') {
        this.logger.info(`[${event}] New message received - Instance: ${JSON.stringify(body, null, 2)}`);
        if (body.key.remoteJid === 'status@broadcast') {
          return;
        }

        if (body.message?.ephemeralMessage?.message) {
          body.message = {
            ...body.message?.ephemeralMessage?.message,
          };
        }

        const originalMessage = await this.getConversationMessage(body.message);
        const bodyMessage = this.aMarkdownDeChatwoot(originalMessage);

        if (bodyMessage && bodyMessage.includes('/survey/responses/') && bodyMessage.includes('http')) {
          return;
        }

        const quotedId = body.contextInfo?.stanzaId || body.message?.contextInfo?.stanzaId;

        let quotedMsg = null;

        if (quotedId)
          quotedMsg = await this.prismaRepository.message.findFirst({
            where: {
              key: {
                path: ['id'],
                equals: quotedId,
              },
              chatwootMessageId: {
                not: null,
              },
            },
          });

        const isMedia = this.isMediaMessage(body.message);

        const adsMessage = this.getAdsMessage(body);

        const reactionMessage = this.getReactionMessage(body.message);
        const isInteractiveButtonMessage = this.isInteractiveButtonMessage(body.messageType, body.message);

        if (!bodyMessage && !isMedia && !reactionMessage && !isInteractiveButtonMessage) {
          this.logger.warn('no body message found');
          return;
        }

        const getConversation = await this.createConversation(instance, body);

        if (!getConversation) {
          this.logger.warn('conversation not found');
          return;
        }

        const messageType = body.key.fromMe ? 'outgoing' : 'incoming';

        // PD: un catálogo (carrusel) trae una imagen POR TARJETA, y no pasa por el camino de medios
        // —`isMediaMessage` no lo reconoce—, así que sin esto llegaba a la bandeja como una línea de
        // texto («Catálogo de la semana») y las fotos se quedaban en WhatsApp.
        if (body.message?.interactiveMessage?.carouselMessage?.cards?.length) {
          const enviado = await this.enviarCarrusel(instance, waInstance, getConversation, messageType, body);

          if (enviado) return enviado;
          // Si falla, sigue el camino normal: mejor el texto suelto que nada.
        }

        if (isMedia) {
          const downloadBase64 = await waInstance?.getBase64FromMediaMessage({
            message: {
              ...body,
            },
          });

          let nameFile: string;
          const messageBody = body?.message[body?.messageType];
          const originalFilename =
            messageBody?.fileName || messageBody?.filename || messageBody?.message?.documentMessage?.fileName;
          if (originalFilename) {
            const parsedFile = path.parse(originalFilename);
            if (parsedFile.name && parsedFile.ext) {
              nameFile = `${parsedFile.name}-${Math.floor(Math.random() * (99 - 10 + 1) + 10)}${parsedFile.ext}`;
            }
          }

          if (!nameFile) {
            nameFile = `${Math.random().toString(36).substring(7)}.${mimeTypes.extension(downloadBase64.mimetype) || ''}`;
          }

          const fileData = Buffer.from(downloadBase64.base64, 'base64');

          const fileStream = new Readable();
          fileStream._read = () => {};
          fileStream.push(fileData);
          fileStream.push(null);

          if (body.key.remoteJid.includes('@g.us')) {
            const participantName = body.pushName;
            const rawPhoneNumber =
              body.key.addressingMode === 'lid' && !body.key.fromMe && body.key.participantAlt
                ? body.key.participantAlt.split('@')[0].split(':')[0]
                : body.key.participant.split('@')[0].split(':')[0];
            const formattedPhoneNumber = parsePhoneNumberFromString(`+${rawPhoneNumber}`).formatInternational();

            let content: string;

            if (!body.key.fromMe) {
              content = bodyMessage
                ? `**${formattedPhoneNumber} - ${participantName}:**\n\n${bodyMessage}`
                : `**${formattedPhoneNumber} - ${participantName}:**`;
            } else {
              content = bodyMessage || '';
            }

            const send = await this.sendData(
              getConversation,
              fileStream,
              nameFile,
              messageType,
              content,
              instance,
              body,
              'WAID:' + body.key.id,
              quotedMsg,
            );

            if (!send) {
              this.logger.warn('message not sent');
              return;
            }

            return send;
          } else {
            const send = await this.sendData(
              getConversation,
              fileStream,
              nameFile,
              messageType,
              bodyMessage,
              instance,
              body,
              'WAID:' + body.key.id,
              quotedMsg,
            );

            if (!send) {
              this.logger.warn('message not sent');
              return;
            }

            return send;
          }
        }

        if (reactionMessage) {
          if (reactionMessage.text) {
            const send = await this.createMessage(
              instance,
              getConversation,
              reactionMessage.text,
              messageType,
              false,
              [],
              {
                message: { extendedTextMessage: { contextInfo: { stanzaId: reactionMessage.key.id } } },
              },
              'WAID:' + body.key.id,
              quotedMsg,
            );
            if (!send) {
              this.logger.warn('message not sent');
              return;
            }
          }

          return;
        }

        if (isInteractiveButtonMessage) {
          const buttons = body.message.interactiveMessage.nativeFlowMessage.buttons;
          this.logger.info('is Interactive Button Message: ' + JSON.stringify(buttons));

          for (const button of buttons) {
            const buttonParams = JSON.parse(button.buttonParamsJson);
            const paymentSettings = buttonParams.payment_settings;

            if (button.name === 'payment_info' && paymentSettings[0].type === 'pix_static_code') {
              const pixSettings = paymentSettings[0].pix_static_code;
              const pixKeyType = (() => {
                switch (pixSettings.key_type) {
                  case 'EVP':
                    return 'Chave Aleatória';
                  case 'EMAIL':
                    return 'E-mail';
                  case 'PHONE':
                    return 'Telefone';
                  default:
                    return pixSettings.key_type;
                }
              })();
              const pixKey = pixSettings.key_type === 'PHONE' ? pixSettings.key.replace('+55', '') : pixSettings.key;
              const content = `*${pixSettings.merchant_name}*\nChave PIX: ${pixKey} (${pixKeyType})`;

              const send = await this.createMessage(
                instance,
                getConversation,
                content,
                messageType,
                false,
                [],
                body,
                'WAID:' + body.key.id,
                quotedMsg,
                this.estructuraDeInteractivo(body.message),
              );
              if (!send) this.logger.warn('message not sent');
            }
          }

          // PD: upstream solo mapeó el caso del PIX brasileño; cualquier otro botón —quick_reply,
          // cta_url…— caía en un `else` que solo escribía «Interactive Button Message not mapped»,
          // así que el mensaje NO se creaba y la conversación no mostraba nada. Ahora se escribe
          // con su texto y sus botones, una sola vez (el bucle de arriba recorre botones, no
          // mensajes: por eso el aviso salía tres veces con tres botones).
          const yaSeEscribioElPix = buttons.some(
            (b: any) => b.name === 'payment_info' && JSON.parse(b.buttonParamsJson ?? '{}').payment_settings,
          );

          if (!yaSeEscribioElPix) {
            const contenido = this.aMarkdownDeChatwoot(this.textoDeInteractivo(body.message.interactiveMessage));

            // Con logo de cabecera hay que subir la imagen, y eso va por otro camino.
            if (body.message.interactiveMessage?.header?.imageMessage) {
              const conLogo = await this.enviarBotonesConLogo(
                instance,
                waInstance,
                getConversation,
                messageType,
                body,
                contenido ?? '',
              );

              if (conLogo) return conLogo;
              // Si la imagen no se pudo bajar, sigue el camino normal: mejor sin logo que sin nada.
            }

            if (contenido) {
              const send = await this.createMessage(
                instance,
                getConversation,
                contenido,
                messageType,
                false,
                [],
                body,
                'WAID:' + body.key.id,
                quotedMsg,
                this.estructuraDeInteractivo(body.message),
              );
              if (!send) this.logger.warn('message not sent');
            } else {
              this.logger.warn('Interactive Button Message not mapped');
            }
          }

          return;
        }

        const isAdsMessage = (adsMessage && adsMessage.title) || adsMessage.body || adsMessage.thumbnailUrl;
        if (isAdsMessage) {
          const imgBuffer = await axios.get(adsMessage.thumbnailUrl, { responseType: 'arraybuffer' });

          const extension = mimeTypes.extension(String(imgBuffer.headers['content-type']));
          const mimeType = extension && mimeTypes.lookup(extension);

          if (!mimeType) {
            this.logger.warn('mimetype of Ads message not found');
            return;
          }

          const random = Math.random().toString(36).substring(7);
          const nameFile = `${random}.${mimeTypes.extension(mimeType)}`;
          const fileData = Buffer.from(imgBuffer.data, 'binary');

          const img = await Jimp.read(fileData);
          await img.cover({
            w: 320,
            h: 180,
          });
          const processedBuffer = await img.getBuffer(JimpMime.png);

          const fileStream = new Readable();
          fileStream._read = () => {}; // _read is required but you can noop it
          fileStream.push(processedBuffer);
          fileStream.push(null);

          const truncStr = (str: string, len: number) => {
            if (!str) return '';

            return str.length > len ? str.substring(0, len) + '...' : str;
          };

          const title = truncStr(adsMessage.title, 40);
          const description = truncStr(adsMessage?.body, 75);

          const send = await this.sendData(
            getConversation,
            fileStream,
            nameFile,
            messageType,
            `${bodyMessage}\n\n\n**${title}**\n${description}\n${adsMessage.sourceUrl}`,
            instance,
            body,
            'WAID:' + body.key.id,
          );

          if (!send) {
            this.logger.warn('message not sent');
            return;
          }

          return send;
        }

        if (body.key.remoteJid.includes('@g.us')) {
          const participantName = body.pushName;
          const rawPhoneNumber =
            body.key.addressingMode === 'lid' && !body.key.fromMe && body.key.participantAlt
              ? body.key.participantAlt.split('@')[0].split(':')[0]
              : body.key.participant.split('@')[0].split(':')[0];
          const formattedPhoneNumber = parsePhoneNumberFromString(`+${rawPhoneNumber}`).formatInternational();

          let content: string;

          if (!body.key.fromMe) {
            content = `**${formattedPhoneNumber} - ${participantName}:**\n\n${bodyMessage}`;
          } else {
            content = `${bodyMessage}`;
          }

          const send = await this.createMessage(
            instance,
            getConversation,
            content,
            messageType,
            false,
            [],
            body,
            'WAID:' + body.key.id,
            quotedMsg,
            this.estructuraDeInteractivo(body.message),
          );

          if (!send) {
            this.logger.warn('message not sent');
            return;
          }

          return send;
        } else {
          const send = await this.createMessage(
            instance,
            getConversation,
            bodyMessage,
            messageType,
            false,
            [],
            body,
            'WAID:' + body.key.id,
            quotedMsg,
            this.estructuraDeInteractivo(body.message),
          );

          if (!send) {
            this.logger.warn('message not sent');
            return;
          }

          return send;
        }
      }

      if (event === Events.MESSAGES_DELETE) {
        const chatwootDelete = this.configService.get<Chatwoot>('CHATWOOT').MESSAGE_DELETE;

        if (chatwootDelete === true) {
          if (!body?.key?.id) {
            this.logger.warn('message id not found');
            return;
          }

          const message = await this.getMessageByKeyId(instance, body.key.id);

          if (message?.chatwootMessageId && message?.chatwootConversationId) {
            await this.prismaRepository.message.deleteMany({
              where: {
                key: {
                  path: ['id'],
                  equals: body.key.id,
                },
                instanceId: instance.instanceId,
              },
            });

            return await client.messages.delete({
              accountId: this.provider.accountId,
              conversationId: message.chatwootConversationId,
              messageId: message.chatwootMessageId,
            });
          }
        }
      }

      if (event === 'messages.edit' || event === 'send.message.update') {
        const editedMessageContentRaw =
          body?.editedMessage?.conversation ??
          body?.editedMessage?.extendedTextMessage?.text ??
          body?.editedMessage?.imageMessage?.caption ??
          body?.editedMessage?.videoMessage?.caption ??
          body?.editedMessage?.documentMessage?.caption ??
          (typeof body?.text === 'string' ? body.text : undefined);

        const editedMessageContent = (editedMessageContentRaw ?? '').trim();

        if (!editedMessageContent) {
          this.logger.info('[CW.EDIT] Conteúdo vazio — ignorando (DELETE tratará se for revoke).');
          return;
        }

        const message = await this.getMessageByKeyId(instance, body?.key?.id);

        if (!message) {
          this.logger.warn('Message not found for edit event');
          return;
        }

        const key = message.key as WAMessageKey;

        const messageType = key?.fromMe ? 'outgoing' : 'incoming';

        if (message && message.chatwootConversationId && message.chatwootMessageId) {
          // Criar nova mensagem com formato: "Mensagem editada:\n\nteste1"
          const editedText = `\n\n\`${i18next.t('cw.message.edited')}:\`\n\n${editedMessageContent}`;

          const send = await this.createMessage(
            instance,
            message.chatwootConversationId,
            editedText,
            messageType,
            false,
            [],
            {
              message: { extendedTextMessage: { contextInfo: { stanzaId: key.id } } },
            },
            'WAID:' + body.key.id,
            null,
          );
          if (!send) {
            this.logger.warn('edited message not sent');
            return;
          }
        }
        return;
      }

      if (event === 'messages.read') {
        if (!body?.key?.id || !body?.key?.remoteJid) {
          this.logger.warn('message id not found');
          return;
        }

        const message = await this.getMessageByKeyId(instance, body.key.id);
        const conversationId = message?.chatwootConversationId;
        const contactInboxSourceId = message?.chatwootContactInboxSourceId;

        if (conversationId) {
          let sourceId = contactInboxSourceId;
          const inbox = (await this.getInbox(instance)) as inbox & {
            inbox_identifier?: string;
          };

          if (!sourceId && inbox) {
            const conversation = (await client.conversations.get({
              accountId: this.provider.accountId,
              conversationId: conversationId,
            })) as conversation_show & {
              last_non_activity_message: { conversation: { contact_inbox: contact_inboxes } };
            };
            sourceId = conversation.last_non_activity_message?.conversation?.contact_inbox?.source_id;
          }

          if (sourceId && inbox?.inbox_identifier) {
            const url =
              `/public/api/v1/inboxes/${inbox.inbox_identifier}/contacts/${sourceId}` +
              `/conversations/${conversationId}/update_last_seen`;
            await chatwootRequest(this.getClientCwConfig(), {
              method: 'POST',
              url: url,
            });
          }
        }
        return;
      }

      if (event === 'status.instance') {
        const data = body;
        const inbox = await this.getInbox(instance);

        if (!inbox) {
          this.logger.warn('inbox not found');
          return;
        }

        const msgStatus = i18next.t('cw.inbox.status', {
          inboxName: inbox.name,
          state: data.status,
        });

        await this.createBotMessage(instance, msgStatus, 'incoming');
      }

      if (event === 'connection.update' && body.status === 'open') {
        const waInstance = this.waMonitor.waInstances[instance.instanceName];
        if (!waInstance) return;

        const now = Date.now();
        const timeSinceLastNotification = now - (waInstance.lastConnectionNotification || 0);

        // Se a conexão foi estabelecida via QR code, notifica imediatamente.
        if (waInstance.qrCode && waInstance.qrCode.count > 0) {
          const msgConnection = i18next.t('cw.inbox.connected');
          await this.createBotMessage(instance, msgConnection, 'incoming');
          waInstance.qrCode.count = 0;
          waInstance.lastConnectionNotification = now;
          chatwootImport.clearAll(instance);
        }
        // Se não foi via QR code, verifica o throttling.
        else if (timeSinceLastNotification >= 30000) {
          const msgConnection = i18next.t('cw.inbox.connected');
          await this.createBotMessage(instance, msgConnection, 'incoming');
          waInstance.lastConnectionNotification = now;
        } else {
          this.logger.warn(
            `Connection notification skipped for ${instance.instanceName} - too frequent (${timeSinceLastNotification}ms since last)`,
          );
        }
      }

      if (event === 'qrcode.updated') {
        if (body.statusCode === 500) {
          const erroQRcode = `🚨 ${i18next.t('qrlimitreached')}`;
          return await this.createBotMessage(instance, erroQRcode, 'incoming');
        } else {
          const fileData = Buffer.from(body?.qrcode.base64.replace('data:image/png;base64,', ''), 'base64');

          const fileStream = new Readable();
          fileStream._read = () => {};
          fileStream.push(fileData);
          fileStream.push(null);

          await this.createBotQr(
            instance,
            i18next.t('qrgeneratedsuccesfully'),
            'incoming',
            fileStream,
            `${instance.instanceName}.png`,
          );

          let msgQrCode = `⚡️${i18next.t('qrgeneratedsuccesfully')}\n\n${i18next.t('scanqr')}`;

          if (body?.qrcode?.pairingCode) {
            msgQrCode =
              msgQrCode +
              `\n\n*Pairing Code:* ${body.qrcode.pairingCode.substring(0, 4)}-${body.qrcode.pairingCode.substring(
                4,
                8,
              )}`;
          }

          await this.createBotMessage(instance, msgQrCode, 'incoming');
        }
      }
    } catch (error) {
      this.logger.error(error);
    }
  }

  public normalizeJidIdentifier(remoteJid: string) {
    if (!remoteJid) {
      return '';
    }
    if (remoteJid.includes('@lid')) {
      return remoteJid;
    }
    return remoteJid.replace(/:\d+/, '').split('@')[0];
  }

  /**
   * Limpa entradas antigas do cache de mapeamento LID
   */
  private cleanLidCache() {
    const now = Date.now();
    this.lidToPhoneMap.forEach((value, lid) => {
      if (now - value.timestamp > this.LID_CACHE_TTL_MS) {
        this.lidToPhoneMap.delete(lid);
      }
    });
  }

  /**
   * Salva mapeamento LID → Número Normal
   */
  private saveLidMapping(lid: string, phoneNumber: string) {
    if (!lid || !phoneNumber || !lid.includes('@lid')) {
      return;
    }

    this.cleanLidCache();
    this.lidToPhoneMap.set(lid, {
      phone: phoneNumber,
      timestamp: Date.now(),
    });

    this.logger.verbose(`LID mapping saved: ${lid} → ${phoneNumber}`);
  }

  /**
   * Resolve LID para Número Normal
   * Retorna o número normal se encontrado, ou o LID original se não encontrado
   */
  private async resolveLidToPhone(instance: InstanceDto, messageKey: any): Promise<string | null> {
    const { remoteJid, remoteJidAlt } = messageKey;

    // Se não for LID, retorna o próprio remoteJid
    if (!remoteJid || !remoteJid.includes('@lid')) {
      return remoteJid;
    }

    // 1. Tenta buscar no cache
    const cached = this.lidToPhoneMap.get(remoteJid);
    if (cached) {
      this.logger.verbose(`LID resolved from cache: ${remoteJid} → ${cached.phone}`);
      return cached.phone;
    }

    // 2. Se tem remoteJidAlt (número alternativo), usa ele e salva no cache
    if (remoteJidAlt && !remoteJidAlt.includes('@lid')) {
      this.saveLidMapping(remoteJid, remoteJidAlt);
      this.logger.verbose(`LID resolved from remoteJidAlt: ${remoteJid} → ${remoteJidAlt}`);
      return remoteJidAlt;
    }

    // 3. Tenta buscar no banco de dados do Chatwoot
    try {
      const lidIdentifier = this.normalizeJidIdentifier(remoteJid);
      const contact = await this.findContactByIdentifier(instance, lidIdentifier);

      if (contact && contact.phone_number) {
        // Converte +554498860240 → 554498860240@s.whatsapp.net
        const phoneNumber = contact.phone_number.replace('+', '') + '@s.whatsapp.net';
        this.saveLidMapping(remoteJid, phoneNumber);
        this.logger.verbose(`LID resolved from database: ${remoteJid} → ${phoneNumber}`);
        return phoneNumber;
      }
    } catch (error) {
      this.logger.warn(`Error resolving LID from database: ${error}`);
    }

    // 4. Se não encontrou, retorna null (será necessário criar novo contato)
    this.logger.warn(`Could not resolve LID: ${remoteJid}`);
    return null;
  }

  public startImportHistoryMessages(instance: InstanceDto) {
    if (!this.isImportHistoryAvailable()) {
      return;
    }

    this.createBotMessage(instance, i18next.t('cw.import.startImport'), 'incoming');
  }

  public isImportHistoryAvailable() {
    const uri = this.configService.get<Chatwoot>('CHATWOOT').IMPORT.DATABASE.CONNECTION.URI;

    return uri && uri !== 'postgres://user:password@hostname:port/dbname';
  }

  public addHistoryMessages(instance: InstanceDto, messagesRaw: MessageModel[]) {
    if (!this.isImportHistoryAvailable()) {
      return;
    }

    chatwootImport.addHistoryMessages(instance, messagesRaw);
  }

  public addHistoryContacts(instance: InstanceDto, contactsRaw: ContactModel[]) {
    if (!this.isImportHistoryAvailable()) {
      return;
    }

    return chatwootImport.addHistoryContacts(instance, contactsRaw);
  }

  public async importHistoryMessages(instance: InstanceDto) {
    if (!this.isImportHistoryAvailable()) {
      return;
    }

    this.createBotMessage(instance, i18next.t('cw.import.importingMessages'), 'incoming');

    const totalMessagesImported = await chatwootImport.importHistoryMessages(
      instance,
      this,
      await this.getInbox(instance),
      this.provider,
    );
    this.updateContactAvatarInRecentConversations(instance);

    const msg = Number.isInteger(totalMessagesImported)
      ? i18next.t('cw.import.messagesImported', { totalMessagesImported })
      : i18next.t('cw.import.messagesException');

    this.createBotMessage(instance, msg, 'incoming');

    return totalMessagesImported;
  }

  public async updateContactAvatarInRecentConversations(instance: InstanceDto, limitContacts = 100) {
    try {
      if (!this.isImportHistoryAvailable()) {
        return;
      }

      const client = await this.clientCw(instance);
      if (!client) {
        this.logger.warn('client not found');
        return null;
      }

      const inbox = await this.getInbox(instance);
      if (!inbox) {
        this.logger.warn('inbox not found');
        return null;
      }

      const recentContacts = await chatwootImport.getContactsOrderByRecentConversations(
        inbox,
        this.provider,
        limitContacts,
      );

      const contactIdentifiers = recentContacts
        .map((contact) => contact.identifier)
        .filter((identifier) => identifier !== null);

      const contactsWithProfilePicture = (
        await this.prismaRepository.contact.findMany({
          where: {
            instanceId: instance.instanceId,
            id: {
              in: contactIdentifiers,
            },
            profilePicUrl: {
              not: null,
            },
          },
        })
      ).reduce((acc: Map<string, ContactModel>, contact: ContactModel) => acc.set(contact.id, contact), new Map());

      recentContacts.forEach(async (contact) => {
        if (contactsWithProfilePicture.has(contact.identifier)) {
          client.contacts.update({
            accountId: this.provider.accountId,
            id: contact.id,
            data: {
              avatar_url: contactsWithProfilePicture.get(contact.identifier).profilePictureUrl || null,
            },
          });
        }
      });
    } catch (error) {
      this.logger.error(`Error on update avatar in recent conversations: ${error.toString()}`);
    }
  }

  public async syncLostMessages(
    instance: InstanceDto,
    chatwootConfig: ChatwootDto,
    prepareMessage: (message: any) => any,
  ) {
    try {
      if (!this.isImportHistoryAvailable()) {
        return;
      }
      if (!this.configService.get<Database>('DATABASE').SAVE_DATA.MESSAGE_UPDATE) {
        return;
      }

      const inbox = await this.getInbox(instance);

      const sqlMessages = `select * from messages m
      where account_id = ${chatwootConfig.accountId}
      and inbox_id = ${inbox.id}
      and created_at >= now() - interval '6h'
      order by created_at desc`;

      const messagesData = (await this.pgClient.query(sqlMessages))?.rows;
      const ids: string[] = messagesData
        .filter((message) => !!message.source_id)
        .map((message) => message.source_id.replace('WAID:', ''));

      const savedMessages = await this.prismaRepository.message.findMany({
        where: {
          Instance: { name: instance.instanceName },
          messageTimestamp: { gte: Number(dayjs().subtract(6, 'hours').unix()) },
          AND: ids.map((id) => ({ key: { path: ['id'], not: id } })),
        },
      });

      const filteredMessages = savedMessages.filter(
        (msg: any) => !chatwootImport.isIgnorePhoneNumber(msg.key?.remoteJid),
      );
      const messagesRaw: any[] = [];
      for (const m of filteredMessages) {
        if (!m.message || !m.key || !m.messageTimestamp) {
          continue;
        }

        if (Long.isLong(m?.messageTimestamp)) {
          m.messageTimestamp = m.messageTimestamp?.toNumber();
        }

        messagesRaw.push(prepareMessage(m as any));
      }

      this.addHistoryMessages(
        instance,
        messagesRaw.filter((msg) => !chatwootImport.isIgnorePhoneNumber(msg.key?.remoteJid)),
      );

      await chatwootImport.importHistoryMessages(instance, this, inbox, this.provider);
      const waInstance = this.waMonitor.waInstances[instance.instanceName];
      waInstance.clearCacheChatwoot();
    } catch {
      return;
    }
  }
}
