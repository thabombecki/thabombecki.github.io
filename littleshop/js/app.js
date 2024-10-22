$(document).foundation(
  
)

$(document).ready(function(){
    $('.conveyorbelt').slick({
        infinite: true,
        arrows: false,
        slidesToShow: 7,
        slidesToScroll: 1,
        autoplay: true,
        autoplaySpeed: 0,
        speed: 1000,
        cssEase: 'linear',
        responsive: [
          {
            breakpoint: 768,
            settings: {
              slidesToShow: 3
            }
          }
        ]
      });
      $('.game-carousel').slick({
        infinite: true,
        centerMode: true,
        centerPadding: "30vw",
        slidesToShow: 1,
        slidesToScroll: 1,
        responsive: [
          {
            breakpoint: 768,
            settings: {
              slidesToShow: 1
            }
          }
        ]
      });
      $('.recyclecel').slick({
          infinite: true,
          slidesToShow: 5,
          slidesToScroll: 1,
          autoplay: true,
          centerMode: true,
          autoplaySpeed: 2000,
          responsive: [
            {
              breakpoint: 768,
              settings: {
                slidesToShow: 2
              }
            }
          ]
        });
      $('.recycle-loop').slick({
        infinite: true,
        slidesToShow: 1,
        slidesToScroll: 1,
        centerMode: true,
        mobileFirst: true,
        responsive: [
          {
            breakpoint: 768,
            settings: "unslick"
          }
        ]
      });
  });