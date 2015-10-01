db.treatments.find().forEach(
  function (elem) {
    db.treatments.update(
      {
        _id: elem._id
      },
      {
        $set: {
          glucose: elem.glucoseValue,
          insulin: elem.insulinGiven,
          carbs: elem.carbsGiven
        }
      }
    );
  }
);
