import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Logger } from '@config/logger.config';
import axios from 'axios';

import { ChannelController, ChannelControllerInterface } from '../channel.controller';
import { CAMPOS_AVISO_CUENTA } from './salud-meta';
import { SaludMetaService } from './salud-meta.service';

export class MetaController extends ChannelController implements ChannelControllerInterface {
  private readonly logger = new Logger('MetaController');

  constructor(
    prismaRepository: PrismaRepository,
    waMonitor: WAMonitoringService,
    // PD 2026-10-03: para apuntar los avisos de cuenta de Meta (ver `apuntarAvisosDeCuenta`).
    private readonly saludMeta?: SaludMetaService,
  ) {
    super(prismaRepository, waMonitor);
  }

  /**
   * PD 2026-10-03: los webhooks de CUENTA (`account_update`, `account_alerts`…) no traen
   * `value.metadata.phone_number_id`, y el bucle de abajo reventaba con un TypeError
   * («Cannot read properties of undefined (reading 'phone_number_id')») que solo dejaba un
   * `unhandledRejection` en el log: el aviso se perdía. Ahora se apuntan en el historial de la
   * instancia (por WABA o número) y se dejan en el log con su resumen. Lo que trae número (los
   * mensajes y sus estados) sigue exactamente igual por el bucle de siempre.
   * Devuelve los cambios que eran avisos sin número, para que el bucle no los toque.
   */
  private apuntarAvisosDeCuenta(data: any): Set<any> {
    const apuntados = new Set<any>();
    for (const entry of Array.isArray(data?.entry) ? data.entry : []) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        if (!change?.field || change.field === 'messages' || change.value?.metadata?.phone_number_id) continue;
        apuntados.add(change);
        if (CAMPOS_AVISO_CUENTA.has(change.field)) {
          this.saludMeta
            ?.registrarAvisoCuenta({ wabaId: entry?.id, time: entry?.time, field: change.field, value: change.value })
            .catch(() => undefined);
        } else if (change.field !== 'message_template_status_update') {
          this.logger.info(
            `Webhook de Meta «${change.field}» (WABA ${entry?.id ?? '?'}) sin manejo en Evolution: se ignora`,
          );
        }
      }
    }
    return apuntados;
  }

  integrationEnabled: boolean;

  public async receiveWebhook(data: any) {
    if (data.object === 'whatsapp_business_account') {
      const avisosSinNumero = this.apuntarAvisosDeCuenta(data);

      if (data.entry[0]?.changes[0]?.field === 'message_template_status_update') {
        const template = await this.prismaRepository.template.findFirst({
          where: { templateId: `${data.entry[0].changes[0].value.message_template_id}` },
        });

        if (!template) {
          console.log('template not found');
          return;
        }

        const { webhookUrl } = template;

        await axios.post(webhookUrl, data.entry[0].changes[0].value, {
          headers: {
            'Content-Type': 'application/json',
          },
        });
        return;
      }

      data.entry?.forEach(async (entry: any) => {
        // PD 2026-10-03: un aviso de cuenta (sin número) ya se apuntó arriba; aquí reventaba.
        if (avisosSinNumero.has(entry?.changes?.[0])) return { status: 'success' };

        const numberId = entry.changes[0].value.metadata.phone_number_id;

        if (!numberId) {
          this.logger.error('WebhookService -> receiveWebhookMeta -> numberId not found');
          return {
            status: 'success',
          };
        }

        const instance = await this.prismaRepository.instance.findFirst({
          where: { number: numberId },
        });

        if (!instance) {
          this.logger.error('WebhookService -> receiveWebhookMeta -> instance not found');
          return {
            status: 'success',
          };
        }

        await this.waMonitor.waInstances[instance.name].connectToWhatsapp(data);

        return {
          status: 'success',
        };
      });
    }

    return {
      status: 'success',
    };
  }
}
