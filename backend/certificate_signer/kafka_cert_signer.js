const {
  CERTIFICATE_NAMESPACE,
  CERTIFICATE_NAMESPACE_V2,
  CERTIFICATE_ISSUER,
  CERTIFICATE_BASE_URL,
  CERTIFICATE_FEEDBACK_BASE_URL,
  CERTIFICATE_INFO_BASE_URL,
  ENABLE_FEEDBACK_URL
} = require ("./config/config");
const {Kafka} = require('kafkajs');
const config = require('./config/config');
const constants = require("./config/constants");
const R = require('ramda');
const {vaccinationContext, vaccinationContextV2} = require("vaccination-context");
const signer = require('certificate-signer-library');
const {publicKeyPem, privateKeyPem} = require('./config/keys');

const CERTIFICATE_TYPE_V2 = "certifyV2";
const CERTIFICATE_TYPE_V3 = "certifyV3";

const kafka = new Kafka({
  clientId: 'divoc-cert',
  brokers: config.KAFKA_BOOTSTRAP_SERVER.split(",")
});

const consumer = kafka.consumer({ groupId: 'certificate_signer', sessionTimeout: config.KAFKA_CONSUMER_SESSION_TIMEOUT });
const producer = kafka.producer({allowAutoTopicCreation: true});

let signingConfig = {
  publicKeyPem: publicKeyPem,
  privateKeyPem: privateKeyPem,

  KAFKA_BOOTSTRAP_SERVER: config.KAFKA_BOOTSTRAP_SERVER,
  KAFKA_CONSUMER_SESSION_TIMEOUT: config.KAFKA_CONSUMER_SESSION_TIMEOUT,
  REGISTRY_URL: config.REGISTRY_URL,
  REGISTRY_CERTIFICATE_SCHEMA: config.REGISTRY_CERTIFICATE_SCHEMA,
  REDIS_URL: config.REDIS_URL,
  REDIS_KEY_EXPIRE: config.REDIS_KEY_EXPIRE,

  CERTIFICATE_NAMESPACE: config.CERTIFICATE_NAMESPACE,
  CERTIFICATE_CONTROLLER_ID: config.CERTIFICATE_CONTROLLER_ID,
  CERTIFICATE_DID: config.CERTIFICATE_DID,
  CERTIFICATE_PUBKEY_ID: config.CERTIFICATE_PUBKEY_ID,
  CERTIFICATE_ISSUER: config.CERTIFICATE_ISSUER,
  CERTIFICATE_BASE_URL: config.CERTIFICATE_BASE_URL,
  CERTIFICATE_FEEDBACK_BASE_URL: config.CERTIFICATE_FEEDBACK_BASE_URL,
  CERTIFICATE_INFO_BASE_URL: config.CERTIFICATE_INFO_BASE_URL,

  CERTIFY_TOPIC: config.CERTIFY_TOPIC,
  CERTIFIED_TOPIC: config.CERTIFIED_TOPIC,
  ENABLE_CERTIFY_ACKNOWLEDGEMENT: config.ENABLE_CERTIFY_ACKNOWLEDGEMENT,
  ERROR_CERTIFICATE_TOPIC: config.ERROR_CERTIFICATE_TOPIC,
  CERTIFICATE_RETRY_COUNT: config.CERTIFICATE_RETRY_COUNT,
  DUPLICATE_CERTIFICATE_TOPIC: config.DUPLICATE_CERTIFICATE_TOPIC,
  CERTIFICATE_ACK_TOPIC: config.CERTIFICATE_ACK_TOPIC,

};

const documentLoader = {};
documentLoader[CERTIFICATE_NAMESPACE] = vaccinationContext;
documentLoader[CERTIFICATE_NAMESPACE_V2] = vaccinationContextV2;

async function initKafkaCertSigner() {
  console.log('Using ' + config.KAFKA_BOOTSTRAP_SERVER);
  console.log('Using ' + publicKeyPem);
  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({topic: config.CERTIFY_TOPIC, fromBeginning: true});

  await signer.init_signer(signingConfig, transformW3, documentLoader);

  await consumer.run({
    eachMessage: async ({topic, partition, message}) => {
      console.time("certify");
      console.log({
        value: message.value.toString(),
        uploadId: message.headers.uploadId ? message.headers.uploadId.toString():'',
        rowId: message.headers.rowId ? message.headers.rowId.toString():'',
      });
      let jsonMessage = {};
      try {
        jsonMessage = JSON.parse(message.value.toString());
        const preEnrollmentCode = R.pathOr("", ["preEnrollmentCode"], jsonMessage);
        const currentDose = R.pathOr("", ["vaccination", "dose"], jsonMessage);
        const programId = R.pathOr("", ["programId"], jsonMessage);
        if (preEnrollmentCode === "" || currentDose === "" || programId === "") {
          throw Error("Required parameters not available")
        }
        const key = `${preEnrollmentCode}-${programId}-${currentDose}`;
        await signer.signCertificate(jsonMessage, message.headers, key);
      } catch (e) {
        // const preEnrollmentCode = R.pathOr("", ["preEnrollmentCode"], jsonMessage);
        // const currentDose = R.pathOr("", ["vaccination", "dose"], jsonMessage);
        // if (preEnrollmentCode !== "" && currentDose !== "") {
        //   redis.deleteKey(`${preEnrollmentCode}-${currentDose}`) //if retry fails it clears the key -
        // }
        console.error("ERROR: " + e.message)
        await producer.send({
          topic: config.ERROR_CERTIFICATE_TOPIC,
          messages: [{key: null, value: JSON.stringify({message: message.value.toString(), error: e.message})}]
        });
      }
      console.timeEnd("certify");
    },
  })
}

function ageOfRecipient(recipient) {
  if (recipient.age) return recipient.age;
  if (recipient.dob && new Date(recipient.dob).getFullYear() > 1900)
    return "" + (Math.floor((new Date() - new Date(recipient.dob))/1000/60/60/24.0/365.25));
  return "";
}

function dobOfRecipient(recipient) {
  if (recipient.dob && new Date(recipient.dob).getFullYear() > 1900) return recipient.dob;
  // administrative dob
  if (recipient.age && recipient.age > 0)
    return (new Date().getFullYear() - recipient.age) + "-01-01";
  return "";
}

function transformW3(cert, certificateId) {
  const certificateType = R.pathOr('', ['meta', 'certificateType'], cert)

  let certificateFromTemplate = {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      CERTIFICATE_NAMESPACE,
    ],
    type: ['VerifiableCredential', 'ProofOfVaccinationCredential'],
    credentialSubject: {
      type: "Person",
      id: R.pathOr('', ['recipient', 'identity'], cert),
      refId: R.pathOr('', ['preEnrollmentCode'], cert),
      name: R.pathOr('', ['recipient', 'name'], cert),
      gender: R.pathOr('', ['recipient', 'gender'], cert),
      age: ageOfRecipient(cert.recipient), //from dob
      nationality: R.pathOr('', ['recipient', 'nationality'], cert),
      address: {
        "streetAddress": R.pathOr('', ['recipient', 'address', 'addressLine1'], cert),
        "streetAddress2": R.pathOr('', ['recipient', 'address', 'addressLine2'], cert),
        "district": R.pathOr('', ['recipient', 'address', 'district'], cert),
        "city": R.pathOr('', ['recipient', 'address', 'city'], cert),
        "addressRegion": R.pathOr('', ['recipient', 'address', 'state'], cert),
        "addressCountry": R.pathOr('IND', ['recipient', 'address', 'country'], cert),
        "postalCode": R.pathOr('', ['recipient', 'address', 'pincode'], cert),
      }
    },
    issuer: CERTIFICATE_ISSUER,
    issuanceDate: new Date().toISOString(),
    evidence: [{
      "id": CERTIFICATE_BASE_URL + certificateId,
      "infoUrl": CERTIFICATE_INFO_BASE_URL + certificateId,
      "certificateId": certificateId,
      "type": ["Vaccination"],
      "batch": R.pathOr('', ['vaccination', 'batch'], cert),
      "vaccine": R.pathOr('', ['vaccination', 'name'], cert),
      "manufacturer": R.pathOr('', ['vaccination', 'manufacturer'], cert),
      "date": R.pathOr('', ['vaccination', 'date'], cert),
      "effectiveStart": R.pathOr('', ['vaccination', 'effectiveStart'], cert),
      "effectiveUntil": R.pathOr('', ['vaccination', 'effectiveUntil'], cert),
      "dose": R.pathOr('', ['vaccination', 'dose'], cert),
      "totalDoses": R.pathOr('', ['vaccination', 'totalDoses'], cert),
      "verifier": {
        "name": R.pathOr('', ['vaccinator', 'name'], cert),
      },
      "facility": {
        // "id": CERTIFICATE_BASE_URL + cert.facility.id,
        "name": R.pathOr('', ['facility', 'name'], cert),
        "address": {
          "streetAddress": R.pathOr('', ['facility', 'address', 'addressLine1'], cert),
          "streetAddress2": R.pathOr('', ['facility', 'address', 'addressLine2'], cert),
          "district": R.pathOr('', ['facility', 'address', 'district'], cert),
          "city": R.pathOr('', ['facility', 'address', 'city'], cert),
          "addressRegion": R.pathOr('', ['facility', 'address', 'state'], cert),
          "addressCountry": R.pathOr('IND', ['facility', 'address', 'country'], cert),
          "postalCode": R.pathOr('', ['facility', 'address', 'pincode'], cert)
        },
      }
    }],
    "nonTransferable": "true"
  };

  if (ENABLE_FEEDBACK_URL) {
    certificateFromTemplate["evidence"][0] = {
      ...certificateFromTemplate["evidence"][0],
      "feedbackUrl": CERTIFICATE_FEEDBACK_BASE_URL + certificateId
    };

  }

  if (certificateType === CERTIFICATE_TYPE_V3) {
    const vaccineName = R.pathOr('', ['vaccination', 'name'], cert);
    const icd11Code = vaccineName ? constants.VACCINE_ICD11_MAPPINGS.filter(a => vaccineName.toLowerCase().includes(a.vaccineName)).map(a => a.icd11Code)[0]: '';
    const prophylaxis = icd11Code ? constants.ICD11_MAPPINGS[icd11Code]["icd11Term"]: '';
    // update context
    certificateFromTemplate["@context"] = [
      "https://www.w3.org/2018/credentials/v1",
      "https://cowin.gov.in/credentials/vaccination/v2"
    ];

    // dob
    certificateFromTemplate["credentialSubject"] = {
      ...certificateFromTemplate["credentialSubject"],
      "dob": dobOfRecipient(cert.recipient),
    };

    // icd11code
    certificateFromTemplate["evidence"][0] = {
      ...certificateFromTemplate["evidence"][0],
      "icd11Code": icd11Code ? icd11Code: '',
      "prophylaxis": prophylaxis ? prophylaxis: '',
    };

  }
  return certificateFromTemplate;
}

module.exports = {
    initKafkaCertSigner
};
