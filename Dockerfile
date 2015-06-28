FROM node:latest

MAINTAINER fokko@driesprong.frl

# Installing the required packages.
RUN apt-get update && apt-get install -y python-software-properties python g++ make git

# Upgrade
RUN apt-get upgrade -y

# https://github.com/jspm/jspm-cli/issues/865
ENV user node

RUN groupadd --system $user && useradd --system --create-home --gid $user $user

COPY . /home/$user/
WORKDIR /home/$user

# We don't wat to run in root.
RUN chown $user --recursive .
USER $user

RUN npm install .

# Expose the default port, although this does not matter at it will be exposed as an arbitrary port by the Docker network driver.
EXPOSE 1337
CMD ["node", "server.js"]