#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GossipGirlStack } from '../lib/gossip-girl-stack';

const app = new cdk.App();

new GossipGirlStack(app, 'GossipGirlStack', {
  description: 'Bedrock AgentCore agent with two-level memory, exposed via API Gateway',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
