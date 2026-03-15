import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      process.env[match[1]] = match[2];
    }
  });
} catch (e) {
  // .env file might not exist, ignore
}

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'logfacedb_dev';

function formatDateIST(date) {
  // Convert any date to IST and return DD-MM-YYYY
  const ist = new Date(new Date(date).getTime() + (5.5 * 60 * 60 * 1000));
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = ist.getUTCFullYear();
  return dd + '-' + mm + '-' + yyyy;
}

function formatTimeIST(date) {
  // Convert any date/time to IST and return hh:mm AM/PM IST
  const ist = new Date(new Date(date).getTime() + (5.5 * 60 * 60 * 1000));
  let hours = ist.getUTCHours();
  const minutes = String(ist.getUTCMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return String(hours).padStart(2, '0') + ':' + minutes + ' ' + ampm + ' IST';
}

function formatDateTimeIST(date) {
  return formatDateIST(date) + ' ' + formatTimeIST(date);
}

function getTodayISTRange() {
  // Returns startOfDay and endOfDay in UTC for querying MongoDB
  // MongoDB stores dates as UTC but represents IST dates
  // IST midnight = UTC 18:30 previous day
  const now = new Date();
  const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const istMidnight = new Date(Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate(),
    0, 0, 0, 0
  ));
  const startUTC = new Date(istMidnight.getTime() - (5.5 * 60 * 60 * 1000));
  const endUTC = new Date(startUTC.getTime() + (24 * 60 * 60 * 1000) - 1);
  return { startUTC, endUTC, istDate: formatDateIST(now) };
}

function getDateISTRange(ddmmyyyy) {
  // Parse DD-MM-YYYY and return UTC range for MongoDB query
  const parts = ddmmyyyy.split('-');
  const dd = parseInt(parts[0]);
  const mm = parseInt(parts[1]) - 1;
  const yyyy = parseInt(parts[2]);
  const istMidnight = new Date(Date.UTC(yyyy, mm, dd, 0, 0, 0, 0));
  const startUTC = new Date(istMidnight.getTime() - (5.5 * 60 * 60 * 1000));
  const endUTC = new Date(startUTC.getTime() + (24 * 60 * 60 * 1000) - 1);
  return { startUTC, endUTC, istDate: ddmmyyyy };
}

function getTodayStringIST() {
  // Returns today's date as YYYY-MM-DD in IST (for punchLog regex matching)
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}

function convertDDMMYYYYtoYYYYMMDD(ddmmyyyy) {
  // Convert DD-MM-YYYY to YYYY-MM-DD for punchLog regex matching
  const parts = ddmmyyyy.split('-');
  return parts[2] + '-' + parts[1] + '-' + parts[0];
}

function getMonthISTRange(mmyyyy) {
  // Parse MM-YYYY and return UTC range for full month
  // mmyyyy format: "03-2026"
  const parts = mmyyyy.split('-');
  const mm = parseInt(parts[0]) - 1;
  const yyyy = parseInt(parts[1]);
  const startIST = new Date(Date.UTC(yyyy, mm, 1, 0, 0, 0, 0));
  const endIST = new Date(Date.UTC(yyyy, mm + 1, 0, 23, 59, 59, 999));
  const startUTC = new Date(startIST.getTime() - (5.5 * 60 * 60 * 1000));
  const endUTC = new Date(endIST.getTime() - (5.5 * 60 * 60 * 1000));
  return { startUTC, endUTC, monthLabel: parts[0] + '-' + parts[1] };
}

function getCurrentMonthLabel() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = ist.getUTCFullYear();
  return mm + '-' + yyyy;
}

async function runQuery() {
  const args = process.argv.slice(2);
  const queryType = args[0];
  const optionalParam = args[1];

  let client;
  try {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db(DB_NAME);

    let result;

    switch (queryType) {
      case 'attendance_today': {
        const { startUTC, endUTC, istDate } = getTodayISTRange();
        const coll = db.collection('attendancePunch');
        const query = { doPnch: { $gte: startUTC, $lte: endUTC } };
        
        const present = await coll.countDocuments({ ...query, atd: 'P' });
        const absent = await coll.countDocuments({ ...query, atd: 'A' });
        const late = await coll.countDocuments({ ...query, atd: 'L' });
        const weekOff = await coll.countDocuments({ ...query, atd: 'WO' });
        const holiday = await coll.countDocuments({ ...query, atd: 'H' });
        const total = present + absent + late + weekOff + holiday;
        
        result = { query: queryType, date: istDate, present, absent, late, weekOff, holiday, total };
        break;
      }
      
      case 'attendance_date': {
        if (!optionalParam) throw new Error('Missing date parameter (DD-MM-YYYY)');
        const { startUTC, endUTC, istDate } = getDateISTRange(optionalParam);
        const coll = db.collection('attendancePunch');
        const query = { doPnch: { $gte: startUTC, $lte: endUTC } };
        
        const present = await coll.countDocuments({ ...query, atd: 'P' });
        const absent = await coll.countDocuments({ ...query, atd: 'A' });
        const late = await coll.countDocuments({ ...query, atd: 'L' });
        const weekOff = await coll.countDocuments({ ...query, atd: 'WO' });
        const holiday = await coll.countDocuments({ ...query, atd: 'H' });
        const total = present + absent + late + weekOff + holiday;
        
        result = { query: queryType, date: istDate, present, absent, late, weekOff, holiday, total };
        break;
      }

      case 'present_today': {
        const { startUTC, endUTC, istDate } = getTodayISTRange();
        const coll = db.collection('attendancePunch');
        const count = await coll.countDocuments({ doPnch: { $gte: startUTC, $lte: endUTC }, atd: 'P' });
        result = { query: queryType, date: istDate, count };
        break;
      }

      case 'absent_today': {
        const { startUTC, endUTC, istDate } = getTodayISTRange();
        const coll = db.collection('attendancePunch');
        const count = await coll.countDocuments({ doPnch: { $gte: startUTC, $lte: endUTC }, atd: 'A' });
        result = { query: queryType, date: istDate, count };
        break;
      }
      
      case 'late_today': {
        const { startUTC, endUTC, istDate } = getTodayISTRange();
        const coll = db.collection('attendancePunch');
        const count = await coll.countDocuments({ doPnch: { $gte: startUTC, $lte: endUTC }, atd: 'L' });
        result = { query: queryType, date: istDate, count };
        break;
      }

      case 'attendance_trend': {
        const days = optionalParam ? parseInt(optionalParam) : 7;
        const trend = [];
        const coll = db.collection('attendancePunch');
        
        const now = new Date();
        const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
        
        for (let i = days - 1; i >= 0; i--) {
          const targetDateIST = new Date(istNow.getTime() - (i * 24 * 60 * 60 * 1000));
          const dd = String(targetDateIST.getUTCDate()).padStart(2, '0');
          const mm = String(targetDateIST.getUTCMonth() + 1).padStart(2, '0');
          const yyyy = targetDateIST.getUTCFullYear();
          const dateStr = dd + '-' + mm + '-' + yyyy;
          
          const { startUTC, endUTC } = getDateISTRange(dateStr);
          const query = { doPnch: { $gte: startUTC, $lte: endUTC } };
          
          const present = await coll.countDocuments({ ...query, atd: 'P' });
          const absent = await coll.countDocuments({ ...query, atd: 'A' });
          const late = await coll.countDocuments({ ...query, atd: 'L' });
          
          trend.push({ date: dateStr, present, absent, late });
        }
        
        result = { query: queryType, days, trend };
        break;
      }

      case 'checkins_today': {
        const yyyyMmDd = getTodayStringIST();
        const dateStrForFormat = yyyyMmDd.split('-').reverse().join('-');
        const coll = db.collection('punchLog');
        const count = await coll.countDocuments({ inOut: 'I', pnchTim: { $regex: '^' + yyyyMmDd } });
        result = { query: queryType, date: dateStrForFormat, count };
        break;
      }

      case 'checkouts_today': {
        const yyyyMmDd = getTodayStringIST();
        const dateStrForFormat = yyyyMmDd.split('-').reverse().join('-');
        const coll = db.collection('punchLog');
        const count = await coll.countDocuments({ inOut: 'O', pnchTim: { $regex: '^' + yyyyMmDd } });
        result = { query: queryType, date: dateStrForFormat, count };
        break;
      }
      
      case 'checkins_date': {
        if (!optionalParam) throw new Error('Missing date parameter (DD-MM-YYYY)');
        const yyyyMmDd = convertDDMMYYYYtoYYYYMMDD(optionalParam);
        const coll = db.collection('punchLog');
        const count = await coll.countDocuments({ inOut: 'I', pnchTim: { $regex: '^' + yyyyMmDd } });
        result = { query: queryType, date: optionalParam, count };
        break;
      }

      case 'recent_punches': {
        const coll = db.collection('punchLog');
        const records = await coll.find().sort({ pnchTim: -1 }).limit(10).toArray();
        const data = records.map(r => {
          let timeFormatted = r.pnchTim;
          if (timeFormatted) {
            const [datePart, timePart] = timeFormatted.split('T');
            if (datePart && timePart) {
              const [yyyy, mm, dd] = datePart.split('-');
              let [hh, mn] = timePart.split(':');
              let hhInt = parseInt(hh);
              const ampm = hhInt >= 12 ? 'PM' : 'AM';
              hhInt = hhInt % 12 || 12;
              timeFormatted = `${dd}-${mm}-${yyyy} ${String(hhInt).padStart(2, '0')}:${mn} ${ampm} IST`;
            }
          }
          
          return {
            empId: r.empId,
            unitName: r.unitName,
            type: r.inOut === 'I' ? 'Check-In' : (r.inOut === 'O' ? 'Check-Out' : r.inOut),
            time: timeFormatted,
            location: r.addr
          };
        });
        result = { query: queryType, data };
        break;
      }

      case 'punches_by_unit': {
        const yyyyMmDd = getTodayStringIST();
        const dateStrForFormat = yyyyMmDd.split('-').reverse().join('-');
        const coll = db.collection('punchLog');
        
        const pipeline = [
          { $match: { pnchTim: { $regex: '^' + yyyyMmDd } } },
          { $group: {
              _id: '$unitName',
              checkIns: { $sum: { $cond: [{ $eq: ['$inOut', 'I'] }, 1, 0] } },
              checkOuts: { $sum: { $cond: [{ $eq: ['$inOut', 'O'] }, 1, 0] } }
            }
          },
          { $project: { _id: 0, unitName: '$_id', checkIns: 1, checkOuts: 1 } },
          { $sort: { unitName: 1 } }
        ];
        
        const units = await coll.aggregate(pipeline).toArray();
        result = { query: queryType, date: dateStrForFormat, units };
        break;
      }

      case 'unit_summary_today': {
        const { startUTC, endUTC, istDate } = getTodayISTRange();
        const coll = db.collection('unitDaySummary');
        
        const pipeline = [
          { $match: { date: { $gte: startUTC, $lte: endUTC } } },
          { $group: {
              _id: null,
              totalPresent: { $sum: { $ifNull: ['$prsntCnt', 0] } },
              totalAbsent: { $sum: { $ifNull: ['$absntCnt', 0] } },
              totalLate: { $sum: { $ifNull: ['$lateCnt', 0] } },
              totalLeave: { $sum: { $ifNull: ['$lvCnt', 0] } },
              totalWeekOff: { $sum: { $ifNull: ['$wkOffCnt', 0] } },
              totalHoliday: { $sum: { $ifNull: ['$hldyCnt', 0] } },
              unitCount: { $sum: 1 }
            }
          }
        ];
        
        const aggResult = await coll.aggregate(pipeline).toArray();
        const summary = aggResult[0] || { totalPresent: 0, totalAbsent: 0, totalLate: 0, totalLeave: 0, totalWeekOff: 0, totalHoliday: 0, unitCount: 0 };
        delete summary._id;
        
        result = { query: queryType, date: istDate, ...summary };
        break;
      }
      
      case 'unit_summary_date': {
        if (!optionalParam) throw new Error('Missing date parameter (DD-MM-YYYY)');
        const { startUTC, endUTC, istDate } = getDateISTRange(optionalParam);
        const coll = db.collection('unitDaySummary');
        
        const pipeline = [
          { $match: { date: { $gte: startUTC, $lte: endUTC } } },
          { $group: {
              _id: null,
              totalPresent: { $sum: { $ifNull: ['$prsntCnt', 0] } },
              totalAbsent: { $sum: { $ifNull: ['$absntCnt', 0] } },
              totalLate: { $sum: { $ifNull: ['$lateCnt', 0] } },
              totalLeave: { $sum: { $ifNull: ['$lvCnt', 0] } },
              totalWeekOff: { $sum: { $ifNull: ['$wkOffCnt', 0] } },
              totalHoliday: { $sum: { $ifNull: ['$hldyCnt', 0] } },
              unitCount: { $sum: 1 }
            }
          }
        ];
        
        const aggResult = await coll.aggregate(pipeline).toArray();
        const summary = aggResult[0] || { totalPresent: 0, totalAbsent: 0, totalLate: 0, totalLeave: 0, totalWeekOff: 0, totalHoliday: 0, unitCount: 0 };
        delete summary._id;
        
        result = { query: queryType, date: istDate, ...summary };
        break;
      }

      case 'total_employees': {
        const coll = db.collection('employee');
        const totalActive = await coll.countDocuments({ isActv: true });
        result = { query: queryType, totalActive };
        break;
      }

      case 'employee_search': {
        if (!optionalParam) throw new Error('Missing search parameter');
        const coll = db.collection('employee');
        
        const query = {
          $or: [
            { empFirst: { $regex: optionalParam, $options: 'i' } },
            { empCd: optionalParam }
          ]
        };
        
        const records = await coll.find(query).limit(5).toArray();
        const results = records.map(r => ({
          name: r.empFirst,
          empCode: r.empCd,
          email: r.email,
          active: r.isActv,
          presentCount: r.prsntCnt || 0,
          absentCount: r.absntCnt || 0,
          lateCount: r.lateCnt || 0,
          joinedOn: r.crtOn ? formatDateIST(r.crtOn) : null
        }));
        
        result = { query: queryType, searchTerm: optionalParam, results };
        break;
      }

      case 'leaves_today': {
        const { startUTC, endUTC, istDate } = getTodayISTRange();
        const coll = db.collection('leaveRequest');
        
        const query = {
          status: 1,
          fromDate: { $lte: endUTC },
          toDate: { $gte: startUTC }
        };
        
        const records = await coll.find(query).toArray();
        const leaves = records.map(l => ({
          empId: l.empId,
          type: l.lvTypeCode,
          days: l.lvDays,
          from: l.fromDate ? formatDateIST(l.fromDate) : null,
          to: l.toDate ? formatDateIST(l.toDate) : null,
          approvedBy: l.crtBy
        }));
        
        result = { query: queryType, date: istDate, count: leaves.length, leaves };
        break;
      }

      case 'pending_leaves': {
        const coll = db.collection('leaveRequest');
        const query = { status: 0 };
        
        const records = await coll.find(query).toArray();
        const requests = records.map(l => ({
          empId: l.empId,
          type: l.lvTypeCode,
          days: l.lvDays,
          requestedOn: l.lvReqDate ? formatDateIST(l.lvReqDate) : null,
          from: l.fromDate ? formatDateIST(l.fromDate) : null,
          to: l.toDate ? formatDateIST(l.toDate) : null,
        }));
        
        result = { query: queryType, count: requests.length, requests };
        break;
      }

      case 'leave_summary_month': {
        const mmyyyy = optionalParam || getCurrentMonthLabel();
        const { startUTC, endUTC, monthLabel } = getMonthISTRange(mmyyyy);
        const coll = db.collection('leaveRequest');
        
        const pipeline = [
          { $match: { status: 1, fromDate: { $gte: startUTC, $lte: endUTC } } },
          { $group: {
              _id: '$lvTypeCode',
              requests: { $sum: 1 },
              totalDays: { $sum: '$lvDays' }
            }
          },
          { $project: { _id: 0, type: '$_id', requests: 1, totalDays: 1 } },
          { $sort: { type: 1 } }
        ];
        
        const breakdown = await coll.aggregate(pipeline).toArray();
        const totalRequests = breakdown.reduce((acc, curr) => acc + curr.requests, 0);
        const totalDays = breakdown.reduce((acc, curr) => acc + curr.totalDays, 0);
        
        result = { query: queryType, month: monthLabel, breakdown, totalRequests, totalDays };
        break;
      }

      case 'wfh_today': {
        const { startUTC, endUTC, istDate } = getTodayISTRange();
        const coll = db.collection('wfhRequest');
        
        const query = {
          status: 1,
          reqDate: { $gte: startUTC, $lte: endUTC }
        };
        
        const records = await coll.find(query).toArray();
        const requests = records.map(r => ({
          empId: r.empId,
          location: r.addr,
          approvedOn: r.reqDate ? formatDateIST(r.reqDate) : null
        }));
        
        result = { query: queryType, date: istDate, count: requests.length, requests };
        break;
      }

      case 'app_logins_today': {
        const { startUTC, endUTC, istDate } = getTodayISTRange();
        const coll = db.collection('userActivity');
        
        const records = await coll.distinct('userId', { date: { $gte: startUTC, $lte: endUTC } });
        
        result = { query: queryType, date: istDate, usersActiveToday: records.length };
        break;
      }

      case 'monthly_summary': {
        const mmyyyy = optionalParam || getCurrentMonthLabel();
        const { startUTC, endUTC, monthLabel } = getMonthISTRange(mmyyyy);
        const coll = db.collection('employeeMonthSummary');
        
        const pipeline = [
          { $match: { date: { $gte: startUTC, $lte: endUTC } } },
          { $group: {
              _id: null,
              totalPresent: { $sum: { $ifNull: ['$prsntCnt', 0] } },
              totalAbsent: { $sum: { $ifNull: ['$absntCnt', 0] } },
              totalLate: { $sum: { $ifNull: ['$lateCnt', 0] } },
              totalLeave: { $sum: { $ifNull: ['$lvCnt', 0] } },
              uniqueEmps: { $addToSet: '$empId' }
            }
          }
        ];
        
        const aggResult = await coll.aggregate(pipeline).toArray();
        const summary = aggResult[0] || { totalPresent: 0, totalAbsent: 0, totalLate: 0, totalLeave: 0, uniqueEmps: [] };
        const employeeCount = summary.uniqueEmps ? summary.uniqueEmps.length : 0;
        
        result = {
          query: queryType,
          month: monthLabel,
          totalPresent: summary.totalPresent,
          totalAbsent: summary.totalAbsent,
          totalLate: summary.totalLate,
          totalLeave: summary.totalLeave,
          employeeCount
        };
        break;
      }

      case 'permissions_today': {
        const { startUTC, endUTC, istDate } = getTodayISTRange();
        const coll = db.collection('permissionRequest');
        
        const query = {
          date: { $gte: startUTC, $lte: endUTC }
        };
        
        const records = await coll.find(query).toArray();
        const requests = records.map(r => ({
          empId: r.empId,
          reason: r.reason,
          from: r.fromTime ? r.fromTime + ' IST' : null,
          to: r.toTime ? r.toTime + ' IST' : null,
          status: r.status === 0 ? 'Pending' : (r.status === 1 ? 'Approved' : (r.status === 2 ? 'Rejected' : 'Cancelled'))
        }));
        
        result = { query: queryType, date: istDate, count: requests.length, requests };
        break;
      }

      case 'pending_permissions': {
        const coll = db.collection('permissionRequest');
        const count = await coll.countDocuments({ status: 0 });
        result = { query: queryType, count };
        break;
      }

      default: {
        result = {
          error: 'Unknown query type',
          note: 'Use dates as DD-MM-YYYY format. Example: node mongo-query.js checkins_date 15-03-2026',
          available: [
            'attendance_today',
            'attendance_date DD-MM-YYYY',
            'attendance_trend <days>',
            'present_today',
            'absent_today',
            'late_today',
            'checkins_today',
            'checkouts_today',
            'checkins_date DD-MM-YYYY',
            'recent_punches',
            'punches_by_unit',
            'unit_summary_today',
            'unit_summary_date DD-MM-YYYY',
            'total_employees',
            'employee_search <name or code>',
            'leaves_today',
            'pending_leaves',
            'leave_summary_month MM-YYYY',
            'wfh_today',
            'app_logins_today',
            'monthly_summary MM-YYYY',
            'permissions_today',
            'pending_permissions'
          ]
        };
        break;
      }
    }

    console.log(JSON.stringify(result, null, 2));

  } catch (error) {
    console.error(JSON.stringify({ error: error.message }, null, 2));
  } finally {
    if (client) {
      await client.close();
    }
  }
}

runQuery();
