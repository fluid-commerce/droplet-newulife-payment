
# main app name or workdir defined in Dockerfile
APPLICATION_NAME=fluid-droplet-newulife-payment
#service as defined in docker compose
SERVICE_NAME=web
SERVICE_TEST_NAME=test

# Local: Use the targets with the 'local' suffix

# Choose a docker-compose
LOCAL_COMPOSE=docker/compose.yml

# Database volume
DB_NAME_VOLUME=postgres_db

help:
	@echo ''
	@echo ''
	@echo 'Usage: make [ARGUMENTS] [EXTRA_ARGUMENTS]'
	@echo ''
	@echo 'ARGUMENTS:'
	@echo '  ---------------------------------------------------------------------'
	@echo '  --------------------Instantiate and start a project------------------'
	@echo '  install: Instantiate the project for the first time local'
	@echo '  up: Run server rails and dependencies for local'
	@echo '  --------------------------------------------------------------------'
	@echo '  --------------------------------------------------------------------'
	@echo '  --------------------Stop and restart a App--------------------------'
	@echo '  stop: Stop app local or staging'
	@echo '  restart: Restart just server rails'
	@echo '  --------------------------------------------------------------------'
	@echo '  --------------------------------------------------------------------'
	@echo '  --------------------Rails Tools-------------------------------------'
	@echo '  console: Run Rails console'
	@echo '  logs: log output local'
	@echo '  rails: Run command rails: rails "<arguments>"'
	@echo '  bundle: Run bundle install staging or local'
	@echo '  --------------------------------------------------------------------'
	@echo '  --------------------------------------------------------------------'
	@echo '  --------------------Docker and CLI Tools----------------------------'
	@echo '  bash: Run shell bash'
	@echo '  ps: Docker status container'
	@echo '  build: Docker build staging or local'
	@echo '  rubocop: Run rubocop "<arguments>"'
	@echo '  --------------------------------------------------------------------'
	@echo '  clean: Clean project and delete all volumes'

# Docker stuff
attach: ## Attach running service to see logs
	@docker attach $(APPLICATION_NAME)-$(SERVICE_NAME)-1

up:
	@make start-local-up

start-local-up:
	@docker compose -f $(LOCAL_COMPOSE) up

start-detach-local:
	@docker compose -f $(LOCAL_COMPOSE) up -d

stop: ## Stop app
	@docker compose -f $(LOCAL_COMPOSE) down

debug-server-local: ## Run Server
	@make start-detach-local
	@make attach

restart: ## Restart app
	@docker compose -f $(LOCAL_COMPOSE) restart $(SERVICE_NAME)

logs:
	@docker compose -f $(LOCAL_COMPOSE) logs -f

bundle:
	@docker compose -f $(LOCAL_COMPOSE) run --rm $(SERVICE_NAME) bundle install -j4 --retry 3

yarn:
	@docker compose -f $(LOCAL_COMPOSE) run --rm $(SERVICE_NAME) yarn install

console:
	@docker compose -f $(LOCAL_COMPOSE) run --rm $(SERVICE_NAME) rails console

rubocop:
	@docker compose -f $(LOCAL_COMPOSE) run --rm $(SERVICE_NAME) bundle exec rubocop $(filter-out $@,$(MAKECMDGOALS))

rails:
	@docker compose -f $(LOCAL_COMPOSE) run --rm --no-deps $(SERVICE_NAME) rails $(filter-out $@,$(MAKECMDGOALS))

clean:
	@docker compose -f $(LOCAL_COMPOSE) down --rmi local --volumes

db-prepare:
	@docker compose -f $(LOCAL_COMPOSE) run --rm $(SERVICE_NAME) rails db:prepare

db-data-delete:
	@make stop
	@docker container prune
	@docker volume rm $(DB_NAME_VOLUME)

migration:
	@docker compose -f $(LOCAL_COMPOSE) run --rm $(SERVICE_NAME) rails db:migrate

ps: ## App status
	@docker compose -f $(LOCAL_COMPOSE) ps

bash: ## Run shell bash
	@docker compose -f $(LOCAL_COMPOSE) run --rm --no-deps $(SERVICE_NAME) bash

build:
	@docker compose -f $(LOCAL_COMPOSE) build

install:
	@make build
	@make bundle
	@make yarn
	@make db-prepare
	@make stop
