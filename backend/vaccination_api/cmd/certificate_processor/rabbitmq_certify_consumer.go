package main

import (
	"fmt"

	"github.com/divoc/api/config"
	log "github.com/sirupsen/logrus"
	"github.com/streadway/amqp"
)

func initAndConsumeFromRabbitmq() {
	config.Initialize()
	log.Infof("Starting certificate processor")
	log.Infof("Using Rabbitmq %s", config.Config.Rabbitmq.RabbitmqServers)
	c, err := amqp.Dial(config.Config.Rabbitmq.RabbitmqServers + "?heartbeat=60")
	failOnError(err, "Failed to connect to RabbitMQ")
	defer c.Close()

	ch, err := c.Channel()
	failOnError(err, "Failed to open a channel")
	defer ch.Close()

	msgs, err := ch.Consume(
		config.Config.Rabbitmq.CertifyTopic, // queue
		"",                                  // consumer
		true,                                // auto-ack
		false,                               // exclusive
		false,                               // no-local
		false,                               // no-wait
		nil,                                 // args
	)
	failOnError(err, "Failed to register a consumer")

	for msg := range msgs {
		if err == nil {
			fmt.Printf("Message on %s: %s\n", msg.Exchange, string(msg.Body))
			//valid := validate.AgainstSchema()
			//if !valid {
			//push to back up queue -- todo what do we do with these requests?
			//}
			//message := signCertificate(message)
			if err := processCertificateMessage(string(msg.Body)); err == nil {
				ch.Ack(msg.DeliveryTag, false)
			} else {
				ch.Reject(msg.DeliveryTag, true)
				log.Errorf("Error in processing the certificate %+v", err)
			}
		} else {
			// The client will automatically try to recover from all errors.
			fmt.Printf("Consumer error: %v \n", err)
		}
	}
}

func failOnError(err error, msg string) {
	if err != nil {
		log.Fatalf("%s: %s", msg, err)
		panic(err)
	}
}
