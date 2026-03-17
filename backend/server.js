import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import qs from 'qs';
import fs from 'fs';

dotenv.config(); 

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

function getTokens() {
  const raw = fs.readFileSync("tokens.json");
  return JSON.parse(raw);
}

//practice console log
/*
app.post('/webhook/nola', async (req, res) => {
  const contact = req.body;
  const triggered_tag = contact.customData?.triggered_tag;

  console.log('==================================================');
  console.log('Triggered tag from workflow:', contact.customData?.triggered_tag);
  console.log('Intern contact ID from workflow:', contact.contact_id);

  // rest of your code...
  res.sendStatus(200); // optional if just testing
});
*/

//OAuth callback endpoint to exchange code for access token
app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code; //from HighLevel
  if (!code) return res.status(400).send('No code provided');

  try {
    const response = await axios.post(
      'https://services.leadconnectorhq.com/oauth/token',
      qs.stringify({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: process.env.REDIRECT_URI,
        code: code
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = response.data;
    console.log('Access token:', access_token);
    console.log(response.data);

    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Error exchanging code for token');
  }
});

//this is the endpoint the webhook will call
app.post('/webhook/nola', async (req, res) => {
  //const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
  //const LOCATION_ID = process.env.LOCATION_ID; 
          //for ref only (optional),, this is static
  const CUSTOM_FIELD_ID = process.env.CUSTOM_FIELD_ID;
  const CUSTOM_FIELD_KEY = process.env.CUSTOM_FIELD_KEY;

  const tokens = getTokens();
  const accessToken = tokens.access_token;
  const locationId = tokens.locationId;

  // // HighLevel sends the payload as a single key
  // const rawPayload = Object.keys(req.body)[0];
  // const contact = JSON.parse(rawPayload); // now you get proper fields
  const contact = req.body.data;

  console.log('Received contact:', contact.contact_id, contact.first_name, contact.last_name);

  console.log('Received payload:', JSON.stringify(req.body, null, 2));
  const triggered_tag = contact.triggered_tag;
                      //contact.customData?.triggered_tag;
  console.log('==================================================');
  //console.log('Received full body:', contact);
  console.log('Received contact:', contact.contact_id, contact.first_name, contact.last_name);

  const source_contact_id = contact.intern_contact_id || req.body.extras.contactId; //haba naman variable name ya

  try {
    //fetch all contacts from NOLA (or apply allowed filters like email)
    const response = await axios.get(
      `https://services.leadconnectorhq.com/contacts`,
      {
        headers: {
          Accept: 'application/json',
          Version: '2021-07-28',
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          locationId: locationId,
          limit: 100  // optional, you can page if more than 100
        }
      }
    );

    //filter in code by custom field intern_contact_id
    const existingContact = response.data.contacts.find(c =>
      c.customFields?.some(f => f.id === CUSTOM_FIELD_ID && f.value?.trim() === source_contact_id?.trim())
    );
    
    // lol, mali pala to, tagal ko nagdebug tas yan lang.. for memories::
    // uh naging tama na sya when i use it sa private app sa marketplace.. ewan bakit,,
    // const existingContact = response.data.contacts.find(c =>
    //   c.customFields?.some(f => f.id === CUSTOM_FIELD_ID && f.field_value === source_contact_id)
    // );
    console.log('source_contact_id:', source_contact_id);
    console.log('Total contacts:', response.data.contacts.length);
    console.log('existingContact:', existingContact);
    console.log('Existing NOLA contact:', existingContact);

    //Next: decide update or create based on existingContact
    if (existingContact) {
      console.log('----------');
      console.log('Contact already exists in NOLA. Ready to UPDATE.');
      const existingTags = existingContact.tags || [];
      const mergedTags = triggered_tag
        ? [...new Set([...existingTags, triggered_tag])]
        : existingTags;

      const updateData = {
        firstName: contact.first_name,
        lastName: contact.last_name,
        name: contact.full_name || `${contact.first_name} ${contact.last_name}`,
        ...(contact.email ? { email: contact.email } : {}),
        ...(contact.phone ? { phone: contact.phone } : {}),
        tags: mergedTags,
        customFields: [
          {
            id: CUSTOM_FIELD_ID, //is the id of our custom field na antagal ko hinanap
            key: CUSTOM_FIELD_KEY, //contact.intern_contact_id
            field_value: source_contact_id
          }
        ]
      };

      console.log('Payload to NOLA (update):', JSON.stringify(updateData, null, 2));

      try {
        const updateResponse = await axios.put(
          `https://services.leadconnectorhq.com/contacts/${existingContact.id}`,
          updateData,
          {
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Version: '2021-07-28',
              Authorization: `Bearer ${accessToken}`
            }
          }
        );

        console.log('Updated NOLA contact:', updateResponse.data);
      } catch (error) {
        const errData = error.response?.data;
        const isDuplicateEmail =
          error.response?.status === 400 &&
          errData?.message?.includes('does not allow duplicated contacts') &&
          errData?.meta?.matchingField === 'email';

        if (isDuplicateEmail) {
          console.log(
            'Duplicate email found during update. Skipping. Existing contact ID:',
            errData.meta.contactId
          );
        } else {
          console.error('Error updating contact in NOLA:', errData || error.message);
        }
      }
    } else {
      console.log('----------');
      console.log('Contact does NOT exist in NOLA. Ready to CREATE.');

      const now = new Date().toISOString(); //timestamp if needed

      const createData = {
        firstName: contact.first_name,
        lastName: contact.last_name,
        name: contact.full_name || `${contact.first_name} ${contact.last_name}`,
        ...(contact.email ? { email: contact.email } : {}),
        ...(contact.phone ? { phone: contact.phone } : {}),
        tags: triggered_tag ? [triggered_tag] : [],
        customFields: [
          {
            id: CUSTOM_FIELD_ID, 
            key: CUSTOM_FIELD_KEY,
            field_value: source_contact_id
          }
        ],
        locationId: locationId
      };

      console.log('Payload to NOLA (create):', JSON.stringify(createData, null, 2));

      const createResponse = await axios.post(
        'https://services.leadconnectorhq.com/contacts',
        createData,
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Version: '2021-07-28',
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      console.log('Created new NOLA contact:', createResponse.data);

      //check if intern_contact_id is present
      const createdCustomFields = createResponse.data.contact.customFields || [];
      const internIdField = createdCustomFields.find(f => f.id === CUSTOM_FIELD_ID);
      if (internIdField) {
        console.log('✅ intern_contact_id saved:', internIdField.value);
      } else {
        console.warn('⚠️ intern_contact_id not saved in customFields!');
      }
    }
    res.sendStatus(200);
  } catch (error) {
    const errData = error.response?.data;

    const isDuplicateEmail =
      error.response?.status === 400 &&
      errData?.message?.includes('does not allow duplicated contacts') &&
      errData?.meta?.matchingField === 'email';
      //only skip when it is specifically the duplicate email error
      //not all 400 errors should be ignored

    if (isDuplicateEmail) {
      console.log('Duplicate email found. Skipping creation. Existing contact ID:', errData.meta.contactId);
      return res.json({ status: 'skipped', reason: 'duplicate email' });
    } else {
      console.error('Error creating contact in NOLA x:', errData || error.message);
      return res.json({ status: 'Error syncing' });
    }
  }
});

app.get("/", (req, res) => res.send("Backend is running wewewe"));

app.listen(port, () => {
  // db.connect();
  console.log(`✅ Backend running at http://localhost:${port} (ykrjm2026)`);
});