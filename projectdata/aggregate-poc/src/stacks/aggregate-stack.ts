/* eslint-disable */
import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as appsync from '@aws-cdk/aws-appsync-alpha';
import { aws_events as events } from 'aws-cdk-lib';
import * as path from 'path';

/**
 * Helpers to compute resource files into cdk objects.
 */
const getResourcePath = (resourceType: string, resourceName: string) => path.join(__dirname, '..', '..', 'resources', resourceType, resourceName);
const getMappingTemplate = (fileName: string): appsync.MappingTemplate => appsync.MappingTemplate.fromFile(getResourcePath('resolver', fileName));
const getSchema = (fileName: string): appsync.Schema => appsync.Schema.fromAsset(getResourcePath('schema', fileName));
const getLambdaCode = (lambdaName: string): any => lambda.Code.fromAsset(getResourcePath('lambda', `${lambdaName}.lambda.zip`));
/**
 * AggregateStack vends an AppSync API, which can store and compute aggregates over a set of known queries.
 */
export class AggregateStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create AppSync API
    const api = new appsync.GraphqlApi(this, 'MoviesApi', {
      name: 'movies',
      schema: getSchema('schema.graphql'),
      authorizationConfig: {
        defaultAuthorization: { authorizationType: appsync.AuthorizationType.API_KEY },
      },
      xrayEnabled: true,
    });

    // Create DDB Table for storing Movies
    const moviesTable = new dynamodb.Table(this, 'MoviesTable', {
      partitionKey: { name: 'year', type: dynamodb.AttributeType.NUMBER },
      sortKey: { name: 'title', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Create DDB Table for storing Aggregates
    const aggregatesTable = new dynamodb.Table(this, 'AggregatesTable', {
      partitionKey: { name: 'model', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'queryExpression', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Create Lambda for computing/updating Aggregates
    const computeAggregatesFunction = new lambda.Function(this, 'ComputeAggregates', {
      runtime: lambda.Runtime.NODEJS_16_X,
      code: getLambdaCode('computeAggregates'),
      handler: 'index.handler',
      environment: {
        AGGREGATES_TABLE_NAME: aggregatesTable.tableName,
        MOVIES_TABLE_NAME: moviesTable.tableName,
      },
      timeout: Duration.seconds(10),
    });

    // Generate Lambdas for populating and querying mock data
    const generateMockDataFunction = new lambda.Function(this, 'GenerateMockData', {
      runtime: lambda.Runtime.NODEJS_16_X,
      code: getLambdaCode('generateMockData'),
      handler: 'index.handler',
      environment: {
        MOVIES_TABLE_NAME: moviesTable.tableName,
      },
      timeout: Duration.minutes(15),
    });

    const benchmarkQueriesFunction = new lambda.Function(this, 'BenchmarkQueries', {
      runtime: lambda.Runtime.NODEJS_16_X,
      code: getLambdaCode('benchmarkQueries'),
      handler: 'index.handler',
      environment: {
        MOVIES_TABLE_NAME: moviesTable.tableName,
      },
      timeout: Duration.seconds(10),
    });

    const eventBus = new events.EventBus(this, 'LogBus', {
      eventBusName: 'AmplifyEventSourceBus'
    });
    const writeBus = new events.EventBus(this, 'WriteBus', {
      eventBusName: 'AmplifySecondaryWriteBus'
    });

    // Generate Resolvers and DataSources to configure the API
    const moviesDataSource = api.addDynamoDbDataSource('MoviesDataSource', moviesTable);
    const aggregatesDataSource = api.addDynamoDbDataSource('AggregatesDataSource', aggregatesTable);
    const computeAggregatesDataSource = api.addLambdaDataSource('ComputeAggregatesDataSource', computeAggregatesFunction);
    const logEventDataSource = api.addHttpDataSource('EventBridgeUSWest2', "https://events.us-west-2.amazonaws.com", {
      name: 'EventLog',
      authorizationConfig: {
        signingRegion: 'us-west-2',
        signingServiceName: 'events',
      },
    });

    moviesDataSource.createResolver({
      typeName: 'Query',
      fieldName: 'moviesByYearLetter',
      requestMappingTemplate: getMappingTemplate('moviesByYearLetter.req.vtl'),
      responseMappingTemplate: getMappingTemplate('moviesByYearLetter.res.vtl'),
    });

    aggregatesDataSource.createResolver({
      typeName: 'Query',
      fieldName: 'count_moviesByYearLetter',
      requestMappingTemplate: getMappingTemplate('count_moviesByYearLetter.req.vtl'),
      responseMappingTemplate: getMappingTemplate('count_moviesByYearLetter.res.vtl'),
    });

    api.createResolver({
      typeName: 'Mutation',
      fieldName: 'putMovie',
      pipelineConfig: [
        logEventDataSource.createFunction({
          name: 'SendLogEvent',
          requestMappingTemplate: getMappingTemplate('putMovie.LogEvent.req.vtl'),
          responseMappingTemplate: getMappingTemplate('putMovie.LogEvent.res.vtl'),
        }),
        moviesDataSource.createFunction({
          name: 'PersistMovie',
          requestMappingTemplate: getMappingTemplate('putMovie.Function1.req.vtl'),
          responseMappingTemplate: getMappingTemplate('putMovie.Function1.res.vtl'),
        }),
        computeAggregatesDataSource.createFunction({
          name: 'ComputeAggregates',
          requestMappingTemplate: getMappingTemplate('putMovie.Function2.req.vtl'),
          responseMappingTemplate: getMappingTemplate('putMovie.Function2.res.vtl'),
        }),
        logEventDataSource.createFunction({
          name: 'SecondaryWriteEvent',
          requestMappingTemplate: getMappingTemplate('putMovie.SecondaryWriteEvent.req.vtl'),
          responseMappingTemplate: getMappingTemplate('putMovie.SecondaryWriteEvent.res.vtl'),
        }),
      ],
      requestMappingTemplate: getMappingTemplate('putMovie.before.vtl'),
      responseMappingTemplate: getMappingTemplate('putMovie.after.vtl'),
    });

    // Grant Access between components
    moviesTable.grantReadData(computeAggregatesFunction);
    moviesTable.grantReadData(computeAggregatesDataSource);
    moviesTable.grantReadWriteData(moviesDataSource);
    moviesTable.grantWriteData(generateMockDataFunction);
    moviesTable.grantReadData(benchmarkQueriesFunction);
    aggregatesTable.grantReadWriteData(computeAggregatesFunction);
    aggregatesTable.grantReadWriteData(computeAggregatesDataSource);
    aggregatesTable.grantReadWriteData(aggregatesDataSource);
    eventBus.grantPutEventsTo(logEventDataSource);
    writeBus.grantPutEventsTo(logEventDataSource);
  }
}