import type { Connector } from './connector';
import { FeedConnector } from './feed.connector';
import { GdeltConnector } from './gdelt.connector';
import { YoutubeConnector } from './youtube.connector';

export const CONNECTOR_KINDS = ['feed', 'gdelt', 'youtube'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

const connectors: Record<ConnectorKind, Connector> = {
  feed: new FeedConnector() as Connector,
  gdelt: new GdeltConnector() as Connector,
  youtube: new YoutubeConnector() as Connector,
};

export const getConnector = (kind: string): Connector | undefined => connectors[kind as ConnectorKind];

/** Collection method stored on the source for each connector kind. */
export const METHOD_FOR_KIND: Record<ConnectorKind, string> = { feed: 'rss', gdelt: 'licensed_provider', youtube: 'social_api' };
