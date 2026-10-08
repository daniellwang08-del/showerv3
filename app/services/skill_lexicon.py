"""Curated technology-skill lexicon and fast extractor.

A pragmatic stand-in for the full ESCO taxonomy (14k skills, external
download): ~400 canonical tech skills with aliases and a category per skill.
Categories provide the "same-branch neighbor" partial credit used by the
vector match scorer (exact skill hit = 1.0, same-category = partial).

Extraction is a single tokenizer pass + n-gram set lookup, so scanning a
15k-char job description takes ~1 ms. Ambiguous one-letter / stop-word-like
names ("C", "R", "Go") are only matched via unambiguous aliases.
"""

from __future__ import annotations

import re
from functools import lru_cache

# canonical skill -> (category, aliases)
# Aliases are matched case-insensitively as token n-grams; the canonical name
# itself is always an alias too (unless listed in _AMBIGUOUS_CANONICALS).
SKILLS: dict[str, tuple[str, tuple[str, ...]]] = {
    # ── Languages ───────────────────────────────────────────────────────
    "python": ("language", ("python3", "python 3")),
    "javascript": ("language", ("js", "ecmascript", "es6")),
    "typescript": ("language", ("ts",)),
    "java": ("language", ()),
    "c++": ("language", ("cpp", "c plus plus")),
    "c#": ("language", ("csharp", "c sharp")),
    "go": ("language", ("golang",)),
    "rust": ("language", ()),
    "ruby": ("language", ()),
    "php": ("language", ()),
    "swift": ("language", ()),
    "kotlin": ("language", ()),
    "scala": ("language", ()),
    "r": ("language", ("r programming", "r language")),
    "matlab": ("language", ()),
    "perl": ("language", ()),
    "elixir": ("language", ()),
    "erlang": ("language", ()),
    "haskell": ("language", ()),
    "clojure": ("language", ()),
    "objective-c": ("language", ("objective c", "objc")),
    "dart": ("language", ()),
    "lua": ("language", ()),
    "groovy": ("language", ()),
    "julia": ("language", ()),
    "fortran": ("language", ()),
    "cobol": ("language", ()),
    "solidity": ("language", ()),
    "bash": ("language", ("shell scripting", "shell script", "bash scripting")),
    "powershell": ("language", ()),
    "sql": ("language", ()),
    "html": ("language", ("html5",)),
    "css": ("language", ("css3",)),
    "sass": ("language", ("scss",)),
    "graphql": ("language", ()),
    "zig": ("language", ()),
    "assembly": ("language", ("x86 assembly", "arm assembly")),
    "vba": ("language", ("visual basic",)),
    "delphi": ("language", ()),
    "abap": ("language", ()),
    # ── Frontend ────────────────────────────────────────────────────────
    "react": ("frontend", ("react.js", "reactjs", "react js")),
    "angular": ("frontend", ("angularjs", "angular.js")),
    "vue": ("frontend", ("vue.js", "vuejs", "vue js")),
    "svelte": ("frontend", ("sveltekit",)),
    "next.js": ("frontend", ("nextjs", "next js")),
    "nuxt": ("frontend", ("nuxt.js", "nuxtjs")),
    "remix": ("frontend", ()),
    "astro": ("frontend", ()),
    "redux": ("frontend", ()),
    "zustand": ("frontend", ()),
    "mobx": ("frontend", ()),
    "rxjs": ("frontend", ()),
    "webpack": ("frontend", ()),
    "vite": ("frontend", ()),
    "babel": ("frontend", ()),
    "tailwind css": ("frontend", ("tailwind", "tailwindcss")),
    "bootstrap": ("frontend", ()),
    "material ui": ("frontend", ("mui", "material-ui")),
    "chakra ui": ("frontend", ()),
    "styled components": ("frontend", ("styled-components",)),
    "storybook": ("frontend", ()),
    "three.js": ("frontend", ("threejs", "webgl")),
    "d3.js": ("frontend", ("d3", "d3js")),
    "jquery": ("frontend", ()),
    "ember": ("frontend", ("ember.js",)),
    "web components": ("frontend", ()),
    "pwa": ("frontend", ("progressive web app", "progressive web apps")),
    "electron": ("frontend", ()),
    "accessibility": ("frontend", ("a11y", "wcag", "web accessibility")),
    # ── Backend frameworks ──────────────────────────────────────────────
    "node.js": ("backend", ("nodejs", "node js", "node")),
    "express": ("backend", ("express.js", "expressjs")),
    "nestjs": ("backend", ("nest.js",)),
    "fastify": ("backend", ()),
    "django": ("backend", ()),
    "flask": ("backend", ()),
    "fastapi": ("backend", ()),
    "rails": ("backend", ("ruby on rails", "ror")),
    "laravel": ("backend", ()),
    "symfony": ("backend", ()),
    "spring": ("backend", ("spring boot", "springboot", "spring framework")),
    "micronaut": ("backend", ()),
    "quarkus": ("backend", ()),
    ".net": ("backend", ("dotnet", "dot net", ".net core", "asp.net", "asp.net core")),
    "gin": ("backend", ()),
    "fiber": ("backend", ()),
    "phoenix": ("backend", ()),
    "grpc": ("backend", ("grpc-web",)),
    "rest api": ("backend", ("rest apis", "restful", "restful api", "restful apis", "rest")),
    "websockets": ("backend", ("websocket", "socket.io")),
    "microservices": ("backend", ("microservice", "micro-services", "service oriented architecture", "soa")),
    "serverless": ("backend", ("faas",)),
    "oauth": ("backend", ("oauth2", "oauth 2.0", "openid connect", "oidc")),
    "jwt": ("backend", ("json web token", "json web tokens")),
    "celery": ("backend", ()),
    "sidekiq": ("backend", ()),
    "temporal": ("backend", ("temporal.io",)),
    "event driven architecture": ("backend", ("event-driven", "event sourcing", "cqrs")),
    "domain driven design": ("backend", ("ddd", "domain-driven design")),
    # ── Mobile ──────────────────────────────────────────────────────────
    "ios": ("mobile", ("ios development", "swiftui", "uikit")),
    "android": ("mobile", ("android development", "jetpack compose")),
    "react native": ("mobile", ()),
    "flutter": ("mobile", ()),
    "xamarin": ("mobile", ()),
    "ionic": ("mobile", ()),
    # ── Databases ───────────────────────────────────────────────────────
    "postgresql": ("database", ("postgres", "psql", "pgsql")),
    "mysql": ("database", ("mariadb",)),
    "sqlite": ("database", ()),
    "sql server": ("database", ("mssql", "microsoft sql server", "t-sql", "tsql")),
    "oracle": ("database", ("oracle db", "pl/sql", "plsql")),
    "mongodb": ("database", ("mongo",)),
    "redis": ("database", ()),
    "elasticsearch": ("database", ("elastic search", "opensearch", "elk")),
    "cassandra": ("database", ()),
    "dynamodb": ("database", ()),
    "couchbase": ("database", ()),
    "neo4j": ("database", ("graph database", "graph databases")),
    "influxdb": ("database", ("time series database",)),
    "clickhouse": ("database", ()),
    "cockroachdb": ("database", ()),
    "firestore": ("database", ("firebase realtime database",)),
    "supabase": ("database", ()),
    "prisma": ("database", ()),
    "sqlalchemy": ("database", ()),
    "hibernate": ("database", ("jpa",)),
    "typeorm": ("database", ()),
    "database design": ("database", ("data modeling", "database modeling", "schema design")),
    "pgvector": ("database", ("vector database", "vector databases")),
    # ── Cloud ───────────────────────────────────────────────────────────
    "aws": ("cloud", ("amazon web services",)),
    "azure": ("cloud", ("microsoft azure",)),
    "gcp": ("cloud", ("google cloud", "google cloud platform")),
    "ec2": ("cloud", ()),
    "s3": ("cloud", ()),
    "lambda": ("cloud", ("aws lambda",)),
    "ecs": ("cloud", ("fargate",)),
    "eks": ("cloud", ()),
    "cloudformation": ("cloud", ()),
    "cloudfront": ("cloud", ()),
    "route53": ("cloud", ("route 53",)),
    "rds": ("cloud", ("aurora",)),
    "sqs": ("cloud", ()),
    "sns": ("cloud", ()),
    "kinesis": ("cloud", ()),
    "azure devops": ("cloud", ()),
    "azure functions": ("cloud", ()),
    "bigquery": ("cloud", ()),
    "cloud run": ("cloud", ()),
    "digitalocean": ("cloud", ("digital ocean",)),
    "heroku": ("cloud", ()),
    "vercel": ("cloud", ()),
    "netlify": ("cloud", ()),
    "cloudflare": ("cloud", ("cloudflare workers",)),
    "openstack": ("cloud", ()),
    "hetzner": ("cloud", ()),
    # ── DevOps / infra ──────────────────────────────────────────────────
    "docker": ("devops", ("docker compose", "docker-compose", "containerization", "containers")),
    "kubernetes": ("devops", ("k8s", "kubectl", "helm")),
    "terraform": ("devops", ()),
    "ansible": ("devops", ()),
    "puppet": ("devops", ()),
    "chef": ("devops", ()),
    "pulumi": ("devops", ()),
    "jenkins": ("devops", ()),
    "github actions": ("devops", ()),
    "gitlab ci": ("devops", ("gitlab ci/cd", "gitlab-ci")),
    "circleci": ("devops", ("circle ci",)),
    "argocd": ("devops", ("argo cd", "gitops")),
    "ci/cd": ("devops", ("continuous integration", "continuous delivery", "continuous deployment", "cicd")),
    "nginx": ("devops", ()),
    "apache": ("devops", ("httpd",)),
    "linux": ("devops", ("ubuntu", "debian", "centos", "rhel", "red hat")),
    "prometheus": ("devops", ()),
    "grafana": ("devops", ()),
    "datadog": ("devops", ()),
    "new relic": ("devops", ("newrelic",)),
    "splunk": ("devops", ()),
    "sentry": ("devops", ()),
    "opentelemetry": ("devops", ("open telemetry", "otel")),
    "observability": ("devops", ("monitoring", "alerting", "apm")),
    "sre": ("devops", ("site reliability", "site reliability engineering")),
    "infrastructure as code": ("devops", ("iac",)),
    "load balancing": ("devops", ("load balancer", "load balancers")),
    "service mesh": ("devops", ("istio", "linkerd", "envoy")),
    "vault": ("devops", ("hashicorp vault", "secrets management")),
    "rabbitmq": ("devops", ()),
    "kafka": ("devops", ("apache kafka", "event streaming")),
    "nats": ("devops", ()),
    "mqtt": ("devops", ()),
    "vmware": ("devops", ("vsphere", "virtualization")),
    "bare metal": ("devops", ("on-premise", "on-prem", "on premise")),
    # ── Data engineering / analytics ────────────────────────────────────
    "spark": ("data", ("apache spark", "pyspark")),
    "hadoop": ("data", ("hdfs", "mapreduce")),
    "airflow": ("data", ("apache airflow",)),
    "dbt": ("data", ()),
    "snowflake": ("data", ()),
    "databricks": ("data", ()),
    "redshift": ("data", ()),
    "flink": ("data", ("apache flink",)),
    "iceberg": ("data", ("apache iceberg",)),
    "hudi": ("data", ("apache hudi",)),
    "delta lake": ("data", ("delta", "delta tables")),
    "beam": ("data", ("apache beam", "dataflow")),
    "etl": ("data", ("elt", "data pipelines", "data pipeline")),
    "data warehousing": ("data", ("data warehouse", "data lake", "data lakehouse")),
    "pandas": ("data", ()),
    "numpy": ("data", ()),
    "tableau": ("data", ()),
    "power bi": ("data", ("powerbi",)),
    "looker": ("data", ()),
    "metabase": ("data", ()),
    "excel": ("data", ("microsoft excel", "spreadsheets")),
    "a/b testing": ("data", ("ab testing", "experimentation")),
    # ── ML / AI ─────────────────────────────────────────────────────────
    "machine learning": ("ml", ("ml",)),
    "deep learning": ("ml", ("neural networks", "neural network")),
    "pytorch": ("ml", ("torch",)),
    "tensorflow": ("ml", ("keras",)),
    "scikit-learn": ("ml", ("sklearn", "scikit learn")),
    "xgboost": ("ml", ("lightgbm", "gradient boosting")),
    "nlp": ("ml", ("natural language processing",)),
    "computer vision": ("ml", ("opencv", "image processing")),
    "llm": ("ml", ("large language models", "large language model", "llms", "gpt", "openai api", "anthropic")),
    "rag": ("ml", ("retrieval augmented generation", "retrieval-augmented generation")),
    "prompt engineering": ("ml", ()),
    "langchain": ("ml", ("llamaindex",)),
    "hugging face": ("ml", ("huggingface", "transformers")),
    "embeddings": ("ml", ("sentence transformers", "vector embeddings", "semantic search")),
    "mlops": ("ml", ("ml ops", "model deployment", "mlflow", "kubeflow")),
    "recommendation systems": ("ml", ("recommender systems", "recommendation engine")),
    "reinforcement learning": ("ml", ("rl",)),
    "generative ai": ("ml", ("genai", "gen ai", "ai agents", "agentic")),
    "data science": ("ml", ()),
    "feature engineering": ("ml", ()),
    # ── Testing / quality ───────────────────────────────────────────────
    "unit testing": ("testing", ("unit tests", "tdd", "test driven development", "test-driven development")),
    "pytest": ("testing", ()),
    "jest": ("testing", ()),
    "mocha": ("testing", ("chai",)),
    "cypress": ("testing", ()),
    "playwright": ("testing", ()),
    "selenium": ("testing", ()),
    "junit": ("testing", ()),
    "integration testing": ("testing", ("integration tests", "e2e testing", "end-to-end testing")),
    "load testing": ("testing", ("performance testing", "jmeter", "k6")),
    "qa": ("testing", ("quality assurance", "test automation")),
    # ── Security ────────────────────────────────────────────────────────
    "application security": ("security", ("appsec", "owasp", "secure coding")),
    "penetration testing": ("security", ("pentesting", "pen testing", "ethical hacking")),
    "cryptography": ("security", ("encryption", "pki", "tls", "ssl")),
    "iam": ("security", ("identity and access management", "sso", "saml", "active directory")),
    "soc 2": ("security", ("soc2", "iso 27001", "compliance")),
    "siem": ("security", ("security monitoring", "incident response")),
    "zero trust": ("security", ()),
    "devsecops": ("security", ()),
    "vulnerability management": ("security", ("vulnerability scanning", "cve")),
    "network security": ("security", ("firewall", "firewalls", "vpn", "ids/ips")),
    # ── Practices / tools ───────────────────────────────────────────────
    "git": ("tools", ("github", "gitlab", "bitbucket", "version control")),
    "jira": ("tools", ("confluence", "atlassian")),
    "agile": ("practice", ("scrum", "kanban", "sprint planning")),
    "code review": ("practice", ("code reviews", "pull requests")),
    "system design": ("practice", ("distributed systems", "scalability", "high availability", "systems design")),
    "api design": ("practice", ("api development", "openapi", "swagger")),
    "performance optimization": ("practice", ("performance tuning", "profiling", "optimization")),
    "caching": ("practice", ("memcached", "cache")),
    "documentation": ("practice", ("technical writing", "technical documentation")),
    "debugging": ("practice", ("troubleshooting", "root cause analysis")),
    "concurrency": ("practice", ("multithreading", "multi-threading", "parallel programming", "async", "asyncio")),
    "web scraping": ("practice", ("scrapy", "data extraction", "crawling", "web crawler")),
    "seo": ("practice", ("search engine optimization",)),
    "stripe": ("domain", ("payment processing", "payments", "billing systems")),
    "salesforce": ("domain", ("crm", "apex")),
    "sap": ("domain", ("sap hana", "sap ecc", "s/4hana", "s4hana")),
    "shopify": ("domain", ("e-commerce", "ecommerce")),
    "twilio": ("domain", ()),
    "blockchain": ("domain", ("web3", "smart contracts", "ethereum", "defi")),
    "iot": ("domain", ("internet of things", "embedded systems", "embedded software", "firmware")),
    "gis": ("domain", ("geospatial", "arcgis", "qgis")),
    "hipaa": ("domain", ("hl7", "fhir", "healthcare it", "ehr", "emr")),
    "fintech": ("domain", ("financial services", "trading systems", "banking")),
    "gaming": ("domain", ("unity", "unreal engine", "game development")),
    "cad": ("domain", ("autocad", "solidworks", "3d modeling")),
    "erp": ("domain", ("netsuite", "workday", "oracle erp")),
    "data migration": ("data", ("data migration", "etl migration", "legacy migration")),
    "data quality": ("data", ("data quality", "dq", "data cleansing", "data cleansing")),
    "master data management": ("data", ("mdm", "master data", "master data management")),
    "data governance": ("data", ("data governance", "data stewardship")),
    "data analysis": ("data", ("data analytics", "business intelligence", "bi", "data analysis", "analytical skills")),
    "consulting": ("domain", ("management consulting", "technology consulting", "client facing")),
    "stakeholder management": ("soft", ("stakeholder management", "client management")),
    "technical leadership": ("soft", ("tech lead", "mentoring", "mentorship", "engineering leadership", "technical lead")),
    "architecture": ("architecture", ("software architecture", "solution architecture", "system architecture")),
    "statistics": ("data", ("statistical analysis", "statistical modeling", "statistical modelling")),
    "experimental design": ("data", ("a/b testing", "ab testing", "experimentation", "experiment design", "experiment analysis")),
    "causal inference": ("data", ("causal modeling", "uplift modeling")),
    "predictive modeling": ("data", ("predictive models", "predictive analytics", "propensity modeling")),
    "data visualization": ("data", ("dashboards", "dashboard development", "data storytelling", "tableau", "looker", "power bi")),
    "product analytics": ("data", ("amplitude", "mixpanel", "funnel analysis", "cohort analysis")),
    "forecasting": ("data", ("demand forecasting", "time series forecasting", "time-series forecasting")),
    "analytics engineering": ("data", ("dbt", "semantic layer", "metrics layer")),
    # ── Engineering practice (phrases the lexicon could not read) ───────
    "software testing": ("testing", ("automated testing", "test automation", "unit testing", "integration testing")),
    "data structures": ("practice", ("algorithms", "data structures and algorithms")),
    "message queues": ("backend", ("message queue", "message brokers", "pub/sub", "event-driven architecture")),
    "distributed tracing": ("devops", ("opentelemetry", "observability", "jaeger")),
    "nosql": ("database", ("nosql databases", "document databases")),
    "authentication": ("security", ("oauth", "oauth2", "openid connect", "authentication and authorization")),
    "cloud security": ("security", ("cloud-native security", "container security", "cspm")),
    "threat modeling": ("security", ("threat models", "security architecture review")),
    "security automation": ("security", ("soar", "detection engineering", "security operations")),
    "platform engineering": ("devops", ("developer platform", "internal developer platform", "developer experience")),
    # ── Sales ───────────────────────────────────────────────────────────
    "sales forecasting": ("sales", ("forecast accuracy", "pipeline forecasting", "revenue forecasting")),
    "pipeline management": ("sales", ("pipeline generation", "pipeline development", "pipeline building", "pipeline creation")),
    "enterprise sales": ("sales", ("enterprise accounts", "strategic accounts", "enterprise selling")),
    "quota attainment": ("sales", ("quota carrying", "exceeded quota", "quota achievement")),
    "full-cycle sales": ("sales", ("full cycle sales", "full sales cycle", "end-to-end sales cycle", "deal closing", "closing deals")),
    "outbound prospecting": ("sales", ("prospecting", "cold calling", "lead generation", "cold outreach")),
    "contract negotiation": ("sales", ("negotiation", "deal negotiation", "commercial negotiation")),
    "saas sales": ("sales", ("software sales", "b2b saas sales", "technology sales")),
    "consultative selling": ("sales", ("solution selling", "value selling", "challenger sale", "meddpicc", "meddic")),
    "territory planning": ("sales", ("territory management", "account planning", "account mapping")),
    "business development": ("sales", ("bizdev", "new business development", "partnership development")),
    "account management": ("sales", ("account manager", "book of business", "account expansion", "upsell", "cross-sell")),
    "product demonstrations": ("sales", ("product demos", "technical demonstrations", "technical presentations")),
    "objection handling": ("sales", ("handling objections",)),
    "sales engineering": ("sales", ("presales", "pre-sales", "solutions engineering", "technical sales", "technical discovery", "proof of concept", "proof of value")),
    "go-to-market strategy": ("sales", ("go-to-market", "gtm strategy")),
    "channel partnerships": ("sales", ("channel sales", "partner management", "alliances", "reseller")),
    # ── Marketing ───────────────────────────────────────────────────────
    "demand generation": ("marketing", ("demand gen", "lead nurturing", "pipeline marketing")),
    "lifecycle marketing": ("marketing", ("retention marketing", "crm marketing")),
    "marketing automation": ("marketing", ("hubspot", "marketo", "pardot", "braze", "iterable", "customer.io")),
    "product marketing": ("marketing", ("product positioning", "product launches", "launch strategy")),
    "content marketing": ("marketing", ("content strategy", "copywriting")),
    "email marketing": ("marketing", ("email campaigns", "newsletters")),
    "growth marketing": ("marketing", ("user acquisition", "growth hacking", "performance marketing", "paid acquisition")),
    "paid media": ("marketing", ("paid social", "paid search", "google ads", "meta ads", "paid social advertising")),
    "account-based marketing": ("marketing", ("account based marketing",)),
    "marketing analytics": ("marketing", ("attribution", "marketing attribution", "campaign analytics", "google analytics")),
    "sales enablement": ("marketing", ("sales collateral", "battlecards")),
    "competitive analysis": ("marketing", ("competitive intelligence", "market research", "market analysis")),
    "brand marketing": ("marketing", ("brand strategy", "brand management")),
    "event marketing": ("marketing", ("field marketing", "trade shows")),
    "campaign management": ("marketing", ("integrated campaigns", "campaign strategy", "campaign execution")),
    "audience segmentation": ("marketing", ("customer segmentation",)),
    # ── Product ─────────────────────────────────────────────────────────
    "product management": ("product", ("product manager", "product ownership", "product owner")),
    "product strategy": ("product", ("product vision", "0 to 1", "0-to-1", "zero to one")),
    "product roadmapping": ("product", ("roadmap planning", "roadmap ownership")),
    "product discovery": ("product", ("customer discovery", "user interviews", "customer interviews", "problem discovery")),
    "product requirements": ("product", ("product specs", "requirements gathering")),
    "technical product management": ("product", ("platform product management", "technical pm", "api products", "developer tools")),
    # ── Design ──────────────────────────────────────────────────────────
    "product design": ("design", ("ux design", "ui/ux", "ux/ui", "user experience design")),
    "design systems": ("design", ("design system", "component library", "ui kit")),
    "figma": ("design", ()),
    "interaction design": ("design", ("interaction patterns", "micro-interactions")),
    "visual design": ("design", ("ui design", "typography", "layout design", "color theory", "graphic design")),
    "user research": ("design", ("usability testing", "ux research", "user testing", "design research")),
    "prototyping": ("design", ("wireframing", "wireframes", "prototypes", "mockups")),
    "motion design": ("design", ("motion graphics", "after effects")),
    "adobe creative suite": ("design", ("photoshop", "illustrator", "indesign", "adobe creative cloud")),
    "design thinking": ("design", ("human-centered design", "human centered design")),
    # ── Customer success / support ─────────────────────────────────────
    "customer success": ("customer", ("customer success management", "client success")),
    "customer retention": ("customer", ("renewals", "renewal management", "churn reduction", "net revenue retention", "nrr", "gross retention")),
    "customer onboarding": ("customer", ("client onboarding",)),
    "product adoption": ("customer", ("customer adoption", "value realization")),
    "technical account management": ("customer", ("strategic account management", "key account management")),
    "customer support": ("customer", ("technical support", "support tickets", "zendesk", "intercom", "help desk", "helpdesk")),
    "customer advocacy": ("customer", ("voice of the customer", "customer references")),
    # ── Finance / accounting ───────────────────────────────────────────
    "financial reporting": ("finance", ("financial statements", "gaap", "us gaap", "ifrs", "sec reporting")),
    "financial modeling": ("finance", ("financial models", "three-statement model")),
    "fp&a": ("finance", ("financial planning and analysis", "financial planning", "budgeting", "budget management")),
    "variance analysis": ("finance", ("budget vs actuals",)),
    "financial analysis": ("finance", ("financial analytics", "unit economics", "saas metrics", "business case development")),
    "financial close": ("finance", ("month-end close", "month end close", "close process", "reconciliations", "account reconciliation")),
    "internal controls": ("finance", ("sox compliance", "external audit")),
    "accounts payable": ("finance", ("procure to pay", "procure-to-pay", "vendor payments")),
    "revenue accounting": ("finance", ("asc 606", "revenue recognition", "technical accounting")),
    "tax": ("finance", ("tax compliance", "sales tax", "indirect tax", "transfer pricing")),
    "headcount planning": ("finance", ("workforce planning", "resource allocation")),
    "corporate finance": ("finance", ("strategic finance", "treasury", "capital allocation", "fundraising")),
    "scenario analysis": ("finance", ("scenario planning", "sensitivity analysis")),
    # ── People / recruiting ────────────────────────────────────────────
    "full-cycle recruiting": ("people", ("full cycle recruiting", "talent acquisition", "candidate sourcing")),
    "technical recruiting": ("people", ("engineering recruiting", "technical hiring")),
    "executive recruiting": ("people", ("executive search", "leadership hiring")),
    "applicant tracking systems": ("people", ("greenhouse", "ashby")),
    "candidate experience": ("people", ("candidate closing", "offer negotiation")),
    "hr business partnering": ("people", ("hr business partner", "people partner", "employee relations")),
    "performance management": ("people", ("performance reviews", "calibration", "talent management", "talent development")),
    "organizational design": ("people", ("org design", "organizational effectiveness", "change management")),
    "employee engagement": ("people", ("engagement surveys", "employee retention")),
    "people analytics": ("people", ("hr analytics", "recruiting analytics", "workforce analytics")),
    "compensation": ("people", ("total rewards", "comp and benefits", "equity compensation")),
    # ── Legal / compliance ─────────────────────────────────────────────
    "contract drafting": ("legal", ("contract review", "commercial contracts", "saas contracting")),
    "commercial law": ("legal", ("commercial counsel", "transactional law", "technology transactions")),
    "privacy law": ("legal", ("data protection", "gdpr", "ccpa", "privacy compliance", "privacy program")),
    "regulatory compliance": ("legal", ("regulatory affairs", "regulatory research", "compliance program")),
    "legal research": ("legal", ("legal analysis", "case law")),
    "legal risk management": ("legal", ("risk assessment", "risk management", "enterprise risk")),
    "litigation": ("legal", ("litigation management", "ediscovery", "e-discovery")),
    "employment law": ("legal", ("labor law", "employment counsel")),
    "intellectual property": ("legal", ("ip law",)),
    # ── Programs / projects / operations ───────────────────────────────
    "program management": ("program", ("technical program management", "program manager", "program leadership")),
    "project management": ("program", ("project manager", "pmp", "project planning", "asana", "smartsheet")),
    "process improvement": ("program", ("process optimization", "six sigma", "workflow design", "operational excellence")),
    "vendor management": ("program", ("supplier management", "vendor selection")),
    "workflow automation": ("program", ("process automation", "zapier", "workato", "business process automation")),
    "strategic planning": ("program", ("corporate strategy", "strategy and operations", "business planning")),
    # ── Leadership ─────────────────────────────────────────────────────
    "people management": ("management", ("team leadership", "managing teams", "direct reports", "team management", "line management")),
    "engineering management": ("management", ("engineering manager", "managing engineers", "engineering leadership")),
    "hiring": ("management", ("team building", "team scaling", "building teams")),
    "cross-functional leadership": ("management", ("cross-functional leadership", "executive communication", "executive presence")),
    # ── Hardware ───────────────────────────────────────────────────────
    "electrical engineering": ("hardware", ("circuit design", "pcb design", "schematic capture", "analog design")),
    "mechanical engineering": ("hardware", ("mechanical design", "tolerance analysis", "gd&t")),
    "new product introduction": ("hardware", ("manufacturing ramp", "contract manufacturers")),
    "hardware testing": ("hardware", ("hardware diagnostics", "validation testing", "test fixtures")),
}

# Canonical names too ambiguous to match as bare English words; these are
# only detected via their unambiguous aliases ("golang", "r programming", ...).
_AMBIGUOUS_CANONICALS = frozenset({"r", "go", "fiber", "gin", "beam"})

_TOKEN_RE = re.compile(r"[a-z0-9+#.\-/]+")

REQUIRED_HEADING_RE = re.compile(
    r"(requirements?|qualifications?|must[\s-]haves?|what\s+you(?:'|’)?ll\s+need|"
    r"what\s+we(?:'|’)?re\s+looking\s+for|minimum\s+qualifications|required\s+skills|"
    r"what\s+it\s+takes|you\s+(?:have|bring)|basic\s+qualifications)",
    re.IGNORECASE,
)
PREFERRED_HEADING_RE = re.compile(
    r"(nice[\s-]to[\s-]haves?|preferred(?:\s+qualifications?|\s+skills)?|bonus(?:\s+points)?|"
    r"plus(?:es)?\b|good\s+to\s+have|desirable|what\s+we\s+offer)",
    re.IGNORECASE,
)


def _normalize_phrase(phrase: str) -> str:
    """Normalize an alias/text chunk to the token-joined lookup form."""
    tokens = _TOKEN_RE.findall(phrase.lower())
    cleaned = []
    for tok in tokens:
        # Split on slashes so "ci/cd" and "tcp/ip" match either notation.
        for part in tok.split("/"):
            part = part.rstrip(".")
            if part:
                cleaned.append(part)
    return " ".join(cleaned)


@lru_cache(maxsize=1)
def _lookup_table() -> tuple[dict[str, str], int]:
    """(normalized alias -> canonical skill, max alias token length)."""
    table: dict[str, str] = {}
    max_len = 1
    for canonical, (_category, aliases) in SKILLS.items():
        names = list(aliases)
        if canonical not in _AMBIGUOUS_CANONICALS:
            names.append(canonical)
        for name in names:
            key = _normalize_phrase(name)
            if not key:
                continue
            table.setdefault(key, canonical)
            max_len = max(max_len, len(key.split()))
    return table, max_len


def skill_category(canonical: str) -> str:
    entry = SKILLS.get(canonical)
    return entry[0] if entry else "other"


def extract_skills(text: str | None) -> set[str]:
    """All canonical skills mentioned in ``text``."""
    if not text:
        return set()
    table, max_len = _lookup_table()
    tokens = _normalize_phrase(text).split()
    found: set[str] = set()
    n = len(tokens)
    for i in range(n):
        for length in range(min(max_len, n - i), 0, -1):
            gram = " ".join(tokens[i:i + length])
            hit = table.get(gram)
            if hit:
                found.add(hit)
                break
    return found


def extract_skills_with_importance(text: str | None) -> dict[str, str]:
    """Canonical skill -> 'required' | 'preferred' | 'mentioned'.

    Splits the JD into spans by requirement/preference headings; skills found
    under a requirements-style heading are 'required', under a nice-to-have
    heading 'preferred', anywhere else 'mentioned'. Required wins on conflict.
    """
    if not text:
        return {}
    spans: list[tuple[str, str]] = []  # (importance, chunk)
    current = "mentioned"
    for line in text.splitlines():
        if REQUIRED_HEADING_RE.search(line) and len(line.strip()) < 80:
            current = "required"
        elif PREFERRED_HEADING_RE.search(line) and len(line.strip()) < 80:
            current = "preferred"
        spans.append((current, line))

    rank = {"mentioned": 0, "preferred": 1, "required": 2}
    result: dict[str, str] = {}
    for importance, chunk in spans:
        for skill in extract_skills(chunk):
            if rank[importance] >= rank.get(result.get(skill, "mentioned"), 0):
                result[skill] = importance
    # A skill never seen under any heading keeps 'mentioned'.
    for skill in extract_skills(text):
        result.setdefault(skill, "mentioned")
    return result
