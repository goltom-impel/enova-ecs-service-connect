import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class EnovaEcsServiceConnectStack extends cdk.Stack {

  readonly logGroup: cdk.aws_logs.LogGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr('172.30.0.0/16'),
    });

    const ecsCluster = new ecs.Cluster(this, "EcsCluster", {
      vpc: vpc,
      clusterName: "enova-ecs-cluster",
    });

    const dnsNamespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "DnsNamespace",
      {
        name: "enova-ecs-service-connect.test",
        vpc: vpc,
      }
    ); 

    this.logGroup = new cdk.aws_logs.LogGroup(this, "LogGroup", {
      logGroupName: "EnovaEcsServiceConnect",
      removalPolicy: cdk.RemovalPolicy.DESTROY, 
      retention: RetentionDays.ONE_WEEK
    });

    // backend - deploy Soneta Server.Standard

    const DBConfig = fs.readFileSync(`./config/lista-baz-danych.xml`, 'utf8');
    const appEnvs = [{ name: "SONETA_DBCONFIG", value: DBConfig }]

    const appPorts = [{ portMappingName: "enova-server", port: 22000 }]

    const enovaServerTaskDefinition = this.buildTaskDefinition("enova-server", "soneta/server.standard:2412.4.6-alpine", appEnvs, appPorts);

    const enovaserverservice = new ecs.FargateService(this, "enova-server-service", {
      cluster: ecsCluster, 
      desiredCount: 2, 
      serviceName: "enova-server",
      taskDefinition: enovaServerTaskDefinition,
      serviceConnectConfiguration: {
        services: appPorts.map(({ portMappingName, port }) => ({
          portMappingName,
          dnsName: portMappingName,
          port,
        })),
        namespace: dnsNamespace.namespaceName,
      },
      enableExecuteCommand: true
    });

    // frontend - deploy Soneta WebServer.Standard

    const webEnvs = [
      { name: "SONETA_SERVER_ENDPOINTS", value: 'http://enova-server:22000' },
      { name: "SONETA_FRONTEND__SERVERENDPOINT", value: 'http://enova-server:22000' },
      { name: "SONETA_URLS", value: 'http://+:8080' },
    ]
    const webPorts = [{ portMappingName: "enova-web", port: 8080 }]
        
    const enovaWebTaskDefinition = this.buildTaskDefinition("enova-web", "soneta/web.standard:2412.4.6-alpine", webEnvs, webPorts);

    const enovawebservice = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "enova-web-service", {
      cluster: ecsCluster, 
      desiredCount: 2, 
      publicLoadBalancer: true, 
      serviceName: "enova-web",
      taskDefinition: enovaWebTaskDefinition,
      enableExecuteCommand: true
    });

    // Have to do this separate because ApplicationLoadBalancedFargateService doesn't support service connect
    enovawebservice.service.enableServiceConnect({
      namespace: dnsNamespace.namespaceName,
    })

    enovawebservice.node.addDependency(dnsNamespace)
    enovaserverservice.node.addDependency(dnsNamespace) 

    enovaserverservice.connections.allowFrom(enovawebservice.service, ec2.Port.tcp(22000))
 
  }

  buildTaskDefinition = (appName: string, dockerImage: string, environment: { name: string, value: string }[], portMappings: { portMappingName: string, port: number }[]) => {

    const taskdef = new ecs.FargateTaskDefinition(this, `${appName}-taskdef`, {
      memoryLimitMiB: 2048, 
      cpu: 512, 
    });

    const container = taskdef.addContainer(`${appName}`, {
      image: ecs.ContainerImage.fromRegistry(dockerImage),
      logging: ecs.LogDrivers.awsLogs({ 
        logGroup: this.logGroup,
        streamPrefix: `service`
      })
    });

    environment.forEach(({ name, value }) =>
      container.addEnvironment( name, value )
    );
   
    portMappings.forEach(({ port, portMappingName }) =>
      container.addPortMappings({ containerPort: port, name: portMappingName})
    );

    taskdef.executionRole?.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"))

    return taskdef
  }
}
