import { ImmichLogger } from '@app/infra/logger';
import { Inject, Injectable } from '@nestjs/common';
import { setTimeout } from 'timers/promises';
import { usePagination } from '../domain.util';
import { IBaseJob, IEntityJob, JOBS_ASSET_PAGINATION_SIZE, JobName, QueueName } from '../job';
import {
  IAssetRepository,
  IJobRepository,
  IMachineLearningRepository,
  ISmartInfoRepository,
  ISystemConfigRepository,
  WithoutProperty,
} from '../repositories';
import { SystemConfigCore } from '../system-config';

@Injectable()
export class SmartInfoService {
  private configCore: SystemConfigCore;
  private logger = new ImmichLogger(SmartInfoService.name);

  constructor(
    @Inject(IAssetRepository) private assetRepository: IAssetRepository,
    @Inject(ISystemConfigRepository) configRepository: ISystemConfigRepository,
    @Inject(IJobRepository) private jobRepository: IJobRepository,
    @Inject(ISmartInfoRepository) private repository: ISmartInfoRepository,
    @Inject(IMachineLearningRepository) private machineLearning: IMachineLearningRepository,
  ) {
    this.configCore = SystemConfigCore.create(configRepository);
  }

  async init() {
    await this.jobRepository.pause(QueueName.SMART_SEARCH);

    let { isActive } = await this.jobRepository.getQueueStatus(QueueName.SMART_SEARCH);
    while (isActive) {
      this.logger.verbose('Waiting for CLIP encoding queue to stop...');
      await setTimeout(1000).then(async () => {
        ({ isActive } = await this.jobRepository.getQueueStatus(QueueName.SMART_SEARCH));
      });
    }

    const { machineLearning } = await this.configCore.getConfig();

    await this.repository.init(machineLearning.clip.modelName);

    await this.jobRepository.resume(QueueName.SMART_SEARCH);
  }

  async handleQueueEncodeClip({ force }: IBaseJob) {
    const { machineLearning } = await this.configCore.getConfig();
    if (!machineLearning.enabled || !machineLearning.clip.enabled) {
      return true;
    }

    const assetPagination = usePagination(JOBS_ASSET_PAGINATION_SIZE, (pagination) => {
      return force
        ? this.assetRepository.getAll(pagination)
        : this.assetRepository.getWithout(pagination, WithoutProperty.CLIP_ENCODING);
    });

    for await (const assets of assetPagination) {
      for (const asset of assets) {
        await this.jobRepository.queue({ name: JobName.ENCODE_CLIP, data: { id: asset.id } });
      }
    }

    return true;
  }

  async handleEncodeClip({ id }: IEntityJob) {
    const { machineLearning } = await this.configCore.getConfig();
    if (!machineLearning.enabled || !machineLearning.clip.enabled) {
      return true;
    }

    const [asset] = await this.assetRepository.getByIds([id]);
    if (!asset.resizePath) {
      return false;
    }

    const clipEmbedding = await this.machineLearning.encodeImage(
      machineLearning.url,
      { imagePath: asset.resizePath },
      machineLearning.clip,
    );

    await this.repository.upsert({ assetId: asset.id }, clipEmbedding);

    return true;
  }
}
