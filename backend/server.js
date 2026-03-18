import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config(); 

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//practice console log
//test for marketplace app testing
app.post('/p', async (req, res) => { 
  console.log('==================================================');
  console.log('Raw payload:', JSON.stringify(req.body, null, 2));

  // Get the actual data key (first key of the object)
  const rawKey = Object.keys(req.body)[0];
  let contact = {};
  
  try {
    contact = JSON.parse(rawKey);
  } catch (err) {
    console.error('Failed to parse contact:', err.message);
  }

  const triggered_tag = contact.triggered_tag;
  const source_contact_id = contact.sync_contact_id;

  console.log('Triggered tag from workflow:', triggered_tag ?? 'undefined');
  console.log('Sync contact ID from workflow:', source_contact_id ?? 'undefined');
  console.log('First name:', contact.first_name ?? 'undefined');
  console.log('Last name:', contact.last_name ?? 'undefined');

  res.sendStatus(200);
});

//this is the endpoint the webhook will call
app.post('/sync', async (req, res) => {
  // HighLevel sends the payload as a single key
  const rawPayload = Object.keys(req.body)[0];
  const contactData = JSON.parse(rawPayload);

  const ACCESS_TOKEN = contactData.pit;
  const LOCATION_ID = contactData.location_id;
  const CUSTOM_FIELD_ID = contactData.custom_field_id; 
  const CUSTOM_FIELD_KEY = contactData.custom_field_key; 

  const contact = JSON.parse(rawPayload); // now you get proper fields
  //const contact = req.body.data;

  console.log('Received contact:', contact.sync_contact_id, contact.first_name, contact.last_name);

  console.log('Received payload:', JSON.stringify(req.body, null, 2));
  const triggered_tag = contact.triggered_tag;
                      //contact.customData?.triggered_tag;
  console.log('==================================================');
  //console.log('Received full body:', contact);
  console.log('Received contact:', contact.sync_contact_id, contact.first_name, contact.last_name);

  const source_contact_id = contact.sync_contact_id || req.body.extras.contactId; //haba naman variable name ya

  try {
    let page = 1;
    let existingContact = null;
    let totalFetched = 0;

    while (true) {
      //fetch all contacts from NOLA (or apply allowed filters like email)
      const response = await axios.get(
        `https://services.leadconnectorhq.com/contacts`,
        {
          headers: {
            Accept: 'application/json',
            Version: '2021-07-28',
            Authorization: `Bearer ${ACCESS_TOKEN}`
          },
          params: {
            locationId: LOCATION_ID,
            limit: 100,  //limit is 100 max i think
            page: page //pagination para sa loops
          }
        }
      );

      const contacts = response.data.contacts;
      totalFetched += contacts.length; //track total fetched for logging

      //filter in code by custom field sync_contact_id
      existingContact = response.data.contacts.find(c =>
        c.customFields?.some(f => f.id === CUSTOM_FIELD_ID && f.value?.trim() === source_contact_id?.trim())
      );

      if (existingContact) break; //found

      if (contacts.length < 100) break; //no more pages

      page++; //increment page for next loop
    }

    console.log('Total contacts checked:', totalFetched);
    console.log('source_contact_id:', source_contact_id);
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
            key: CUSTOM_FIELD_KEY, //contact.sync_contact_id
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
              Authorization: `Bearer ${ACCESS_TOKEN}`
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
        locationId: LOCATION_ID
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
            Authorization: `Bearer ${ACCESS_TOKEN}`
          }
        }
      );

      console.log('Created new NOLA contact:', createResponse.data);

      //check if sync_contact_id is present
      const createdCustomFields = createResponse.data.contact.customFields || [];
      const syncIdField = createdCustomFields.find(f => f.id === CUSTOM_FIELD_ID);
      
      if (syncIdField) {
        console.log('✅ sync_contact_id saved:', syncIdField.value);
      } else {
        console.warn('⚠️ sync_contact_id not saved in customFields!');
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

app.get("/", (req, res) => res.send("Backend is running sync proj"));

app.listen(port, () => {
  // db.connect();
  console.log(`✅ Backend running at http://localhost:${port} (ykrjm2026)`);
});