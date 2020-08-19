import os from 'os';
import { ApolloServerPlugin } from 'apollo-server-plugin-base';
import { v4 as uuidv4 } from 'uuid';
import { printSchema } from 'graphql';
import { SchemaReporter } from './schemaReporter';
import createSHA from '../../utils/createSHA';

export interface ApolloServerPluginSchemaReportingOptions {
  /**
   * The schema reporter waits before starting reporting.
   * By default, the report waits some random amount of time between 0 and 10 seconds.
   * A longer interval leads to more staggered starts which means it is less likely
   * multiple servers will get asked to upload the same schema.
   *
   * If this server runs in lambda or in other constrained environments it would be useful
   * to decrease the schema reporting max wait time to be less than default.
   *
   * This number will be the max for the range in ms that the schema reporter will
   * wait before starting to report.
   */
  initialDelayMaxMs?: number;
  /**
   * Override the reported schema that is reported to the Apollo registry.
   * This schema does not go through any normalizations and the string is
   * directly sent to the Apollo registry.
   * This would be useful for comments or other ordering and whitespace
   *  changes that get stripped when generating a `GraphQLSchema`
   */
  overrideReportedSchema?: string;
  /**
   * The URL to use for reporting schemas. Primarily for testing and internal
   * Apollo use.
   */
  endpointUrl?: string;
}

export function ApolloServerPluginSchemaReporting(
  {
    initialDelayMaxMs,
    overrideReportedSchema,
    endpointUrl,
  }: ApolloServerPluginSchemaReportingOptions = Object.create(null),
): ApolloServerPlugin {
  const bootId = uuidv4();

  return {
    __internal_plugin_id__() {
      return 'SchemaReporting';
    },
    async serverWillStart({ apollo, schema, logger }) {
      const { key } = apollo;
      if (!key) {
        throw Error(
          'To use ApolloServerPluginSchemaReporting, you must provide an Apollo API ' +
            'key, via the $APOLLO_KEY environment variable or via `new ApolloServer({apollo: {key})`',
        );
      }
      if (!apollo.graphId) {
        throw Error(
          "To use ApolloServerPluginSchemaReporting, you must provide your graph's ID, " +
            "either by using an API key starting with 'service:',  or by providing it explicitly via " +
            'the $APOLLO_GRAPH_ID environment variable or via `new ApolloServer({apollo: {graphId}})`',
        );
      }

      const executableSchema = overrideReportedSchema ?? printSchema(schema);
      const executableSchemaId = computeExecutableSchemaId(executableSchema);

      if (overrideReportedSchema !== undefined) {
        logger.info(
          'Apollo schema reporting: schema to report has been overridden',
        );
      }
      if (endpointUrl !== undefined) {
        logger.info(
          `Apollo schema reporting: schema reporting URL override: ${endpointUrl}`,
        );
      }

      const serverInfo = {
        bootId,
        graphVariant: apollo.graphVariant,
        // The infra environment in which this edge server is running, e.g. localhost, Kubernetes
        // Length must be <= 256 characters.
        platform: process.env.APOLLO_SERVER_PLATFORM || 'local',
        runtimeVersion: `node ${process.version}`,
        executableSchemaId: executableSchemaId,
        // An identifier used to distinguish the version of the server code such as git or docker sha.
        // Length must be <= 256 charecters
        userVersion: process.env.APOLLO_SERVER_USER_VERSION,
        // "An identifier for the server instance. Length must be <= 256 characters.
        serverId:
          process.env.APOLLO_SERVER_ID || process.env.HOSTNAME || os.hostname(),
        libraryVersion: `apollo-server-core@${
          require('../../../package.json').version
        }`,
      };

      logger.info(
        `Apollo schema reporting: starting for graph ${apollo.graphId}@${
          apollo.graphVariant
        } with server info ${JSON.stringify(serverInfo)}`,
      );

      const schemaReporter = new SchemaReporter({
        serverInfo,
        schemaSdl: executableSchema,
        apiKey: key,
        endpointUrl,
        logger,
        // Jitter the startup between 0 and 10 seconds
        initialReportingDelayInMs: Math.floor(
          Math.random() * (initialDelayMaxMs ?? 10_000),
        ),
        fallbackReportingDelayInMs: 20_000,
      });

      schemaReporter.start();

      return {
        async serverWillStop() {
          schemaReporter.stop();
        },
      };
    },
  };
}

export function computeExecutableSchemaId(schema: string): string {
  return createSHA('sha256').update(schema).digest('hex');
}