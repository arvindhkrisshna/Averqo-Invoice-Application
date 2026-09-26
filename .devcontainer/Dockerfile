FROM mcr.microsoft.com/devcontainers/base:noble

# MySQL command-line client, handy for looking inside the database:
#   mysql -h db -u invoice -pinvoicepass invoicedb
RUN apt-get update \
    && apt-get install -y --no-install-recommends mysql-client \
    && rm -rf /var/lib/apt/lists/*
